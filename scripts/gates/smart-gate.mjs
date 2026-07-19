#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoots = ["apps", "infrastructure", "packages", "sdks/typescript", "tools"];
const sourceExtensions = new Set([".cjs", ".ex", ".exs", ".go", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const formatExtensions = new Set([".css", ".html", ".js", ".json", ".jsonc", ".jsx", ".md", ".mdx", ".mjs", ".ts", ".tsx", ".yaml", ".yml"]);
const dependencyBasenames = new Set(["go.mod", "go.sum", "mix.exs", "mix.lock", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
const gateDefinitionPaths = new Set([".fallowrc.json", "lefthook.yml", "package.json", "pnpm-workspace.yaml", "turbo.json", ".github/workflows/ci.yml"]);

function gitLines(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeFiles(files) {
  return [...new Set(files.map((file) => file.replaceAll("\\", "/")).filter(Boolean))].sort();
}

function isDocumentation(file) {
  return file.startsWith("scratchpad/") || [".md", ".mdx", ".txt"].includes(path.extname(file));
}

function isExistingFile(file) {
  return existsSync(path.join(repositoryRoot, file));
}

function startsWithAny(file, prefixes) {
  return prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));
}

function isGateDefinition(file) {
  return gateDefinitionPaths.has(file) || file.startsWith("scripts/gates/");
}

function isKnownPath(file, workspaces) {
  if (isDocumentation(file) || workspaces.some((workspace) => startsWithAny(file, [workspace.directory]))) return true;
  if (startsWithAny(file, ["apps/api", "apps/sync", "contract", "docs", "scripts", "infrastructure/architecture-worker", "infrastructure/recorder"])) return true;
  if (file.startsWith(".github/") || file.startsWith(".agents/") || file.startsWith(".semgrep/")) return true;
  if (["architecture.html", "CHANGELOG.md", "LICENSE", "README.md", "cspell.json", "lefthook.yml", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json"].includes(file)) return true;
  return [".gitignore", ".gitleaks.toml", ".npmrc", ".oxfmtrc.json", ".fallowrc.json"].includes(file);
}

export function discoverWorkspaces(root = repositoryRoot) {
  const manifests = gitLines(["ls-files", "*/package.json", "*/*/package.json", "*/*/*/package.json"]);
  return manifests
    .map((manifest) => {
      const directory = path.posix.dirname(manifest);
      if (!workspaceRoots.some((workspaceRoot) => startsWithAny(directory, [workspaceRoot]))) return null;
      const packageJson = JSON.parse(readFileSync(path.join(root, manifest), "utf8"));
      if (!packageJson.name) return null;
      const dependencies = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies, ...packageJson.optionalDependencies, ...packageJson.peerDependencies });
      return { name: packageJson.name, directory, scripts: packageJson.scripts ?? {}, dependencies, isPublic: packageJson.private !== true };
    })
    .filter(Boolean)
    .sort((left, right) => left.directory.localeCompare(right.directory));
}

function affectedWorkspaces(files, workspaces, selectAll) {
  const selected = new Set(selectAll ? workspaces.map((workspace) => workspace.name) : workspaces.filter((workspace) => files.some((file) => startsWithAny(file, [workspace.directory]) && !isDocumentation(file))).map((workspace) => workspace.name));

  let changed = true;
  while (changed) {
    changed = false;
    for (const workspace of workspaces) {
      if (selected.has(workspace.name) || !workspace.dependencies.some((dependency) => selected.has(dependency))) continue;
      selected.add(workspace.name);
      changed = true;
    }
  }
  return workspaces.filter((workspace) => selected.has(workspace.name));
}

function filteredPnpmCommand(workspaces, script, trailingArguments = []) {
  const runnable = workspaces.filter((workspace) => workspace.scripts[script]);
  if (runnable.length === 0) return null;
  return ["pnpm", ...runnable.flatMap((workspace) => ["--filter", workspace.name]), "run", script, ...trailingArguments];
}

function task(id, label, selected, reason, command, env = {}) {
  return { id, label, selected: Boolean(selected && command), reason, command, env };
}

export function createGatePlan(files, options = {}) {
  const normalizedFiles = normalizeFiles(files);
  const addedFiles = normalizeFiles(options.addedFiles ?? []);
  const workspaces = options.workspaces ?? discoverWorkspaces();
  const explicitFull = options.full === true;
  const gateDefinition = normalizedFiles.find(isGateDefinition);
  const unknownPath = normalizedFiles.find((file) => !isKnownPath(file, workspaces));
  const full = explicitFull || Boolean(gateDefinition) || Boolean(unknownPath);
  const fullReason = explicitFull ? "--full requested" : gateDefinition ? `${gateDefinition} changes gate behavior` : unknownPath ? `${unknownPath} is not classified` : null;
  const nonDocumentationFiles = normalizedFiles.filter((file) => !isDocumentation(file));
  const dependencyChange = full || normalizedFiles.some((file) => dependencyBasenames.has(path.posix.basename(file)));
  const allJavaScript = full || normalizedFiles.includes("pnpm-lock.yaml") || normalizedFiles.includes("pnpm-workspace.yaml") || normalizedFiles.includes("turbo.json") || normalizedFiles.includes("package.json");
  const selectedWorkspaces = affectedWorkspaces(nonDocumentationFiles, workspaces, allJavaScript);
  const selectedNames = selectedWorkspaces.map((workspace) => workspace.name).join(", ");
  const api = full || nonDocumentationFiles.some((file) => startsWithAny(file, ["apps/api"]));
  const sync = full || nonDocumentationFiles.some((file) => startsWithAny(file, ["apps/sync"]));
  const contracts = full || api || nonDocumentationFiles.some((file) => startsWithAny(file, ["contract", "scripts/codegen", "scripts/contracts", "tools/contract-codegen", "sdks/typescript/client/src/generated"]));
  const architecture = full || nonDocumentationFiles.some((file) => file === "architecture.html" || startsWithAny(file, ["infrastructure/architecture-worker", "packages/assets/src/logos", "scripts/architecture-worker"]));
  const recorder = full || nonDocumentationFiles.some((file) => startsWithAny(file, ["infrastructure/recorder", "scripts/recorder"]));
  const sourceFiles = nonDocumentationFiles.filter((file) => sourceExtensions.has(path.extname(file)) && isExistingFile(file));
  const formattedFiles = normalizedFiles.filter((file) => formatExtensions.has(path.extname(file)) && isExistingFile(file));
  const publishableWorkspaces = selectedWorkspaces.filter((workspace) => workspace.isPublic && startsWithAny(workspace.directory, ["packages", "sdks/typescript"]));
  const serviceGates = [api ? "apps/api/scripts/gate.sh" : null, sync ? "apps/sync/scripts/gate.sh" : null].filter(Boolean);
  const base = options.base ?? process.env.GATE_BASE_REF ?? "origin/master";
  const scope = options.scope ?? "staged";
  const fallowCommand = explicitFull ? ["pnpm", "run", "static:fallow"] : scope === "staged" ? ["bash", "-lc", "git diff --cached --no-ext-diff --binary | pnpm exec fallow audit --diff-stdin"] : ["pnpm", "exec", "fallow", "audit", "--changed-since", base];
  const formatCommand = formattedFiles.length > 0 ? ["pnpm", "exec", "oxfmt", "--check", ...formattedFiles] : null;
  const semgrepCommand = explicitFull || (full && scope !== "staged") ? ["bash", "scripts/gates/semgrep.sh"] : sourceFiles.length > 0 ? ["bash", "scripts/gates/semgrep.sh", ...sourceFiles] : null;
  const testPresenceFiles = addedFiles.join("\n");

  const tasks = [
    task("self-test", "Gate routing tests", true, "always required", ["node", "--test", "scripts/gates/smart-gate.test.mjs"]),
    task("hygiene", "Repository hygiene", true, "always required", ["pnpm", "run", "gate:hygiene"]),
    task("secrets", "Secret scan", true, "always required for the selected diff", ["bash", "scripts/gates/gitleaks.sh"], { GATE_SCOPE: scope, GITLEAKS_BASE_REF: base }),
    task("architecture", "Architecture Worker", architecture, architecture ? "architecture inputs changed" : "no architecture inputs changed", ["pnpm", "run", "architecture:test"]),
    task("format", "Formatting", Boolean(formatCommand), full ? fullReason : `${formattedFiles.length} changed formattable file(s)`, formatCommand),
    task("fallow", "Changed-code analysis", full || architecture || sourceFiles.length > 0, full ? fullReason : architecture ? "architecture inputs changed" : `${sourceFiles.length} source file(s) changed`, fallowCommand),
    task("semgrep", "Static security rules", Boolean(semgrepCommand), full ? fullReason : `${sourceFiles.length} source file(s) changed`, semgrepCommand),
    task("osv", "Dependency vulnerability scan", dependencyChange, dependencyChange ? "dependency inputs changed" : "no dependency inputs changed", ["bash", "scripts/gates/osv-scanner.sh"]),
    task("services", "Service-backed API and basic Sync gates", serviceGates.length > 0, serviceGates.length > 0 ? serviceGates.join(" and ") : "API and Sync are unaffected", ["bash", "scripts/gates/with-postgres.sh", ...serviceGates], { CHALK_SYNC_GATE_MODE: "basic" }),
    task("contracts", "Contract and generated SDK drift", contracts, contracts ? "contract producers or consumers changed" : "contracts are unaffected", ["pnpm", "run", "contract:check"]),
    task("syncpack", "Workspace dependency policy", dependencyChange, dependencyChange ? "workspace dependency inputs changed" : "workspace dependency inputs are unchanged", ["pnpm", "run", "deps:syncpack"]),
    task("test-presence", "Test presence", full || sourceFiles.some((file) => [".ts", ".tsx"].includes(path.extname(file))), "TypeScript source files changed", ["pnpm", "run", "test:presence"], { TEST_PRESENCE_FILES: testPresenceFiles, TEST_PRESENCE_BASE_REF: base }),
    task("types", "Affected workspace type checks", selectedWorkspaces.length > 0, selectedNames || "no affected workspace", filteredPnpmCommand(selectedWorkspaces, "check-types")),
    task("tests", "Affected workspace tests with coverage", selectedWorkspaces.length > 0, selectedNames || "no affected workspace", filteredPnpmCommand(selectedWorkspaces, "test", ["--coverage"])),
    task("build", "Affected workspace builds", selectedWorkspaces.length > 0, selectedNames || "no affected workspace", filteredPnpmCommand(selectedWorkspaces, "build")),
    task("recorder", "Recorder infrastructure", recorder, recorder ? "recorder inputs changed" : "no recorder inputs changed", ["pnpm", "run", "recorder:gate"]),
    task(
      "publint",
      "Affected package publication layout",
      publishableWorkspaces.length > 0,
      publishableWorkspaces.map((workspace) => workspace.name).join(", ") || "no affected public package",
      publishableWorkspaces.length > 0 ? ["pnpm", ...publishableWorkspaces.flatMap((workspace) => ["--filter", workspace.name]), "exec", "publint"] : null,
    ),
    task(
      "attw",
      "Affected package TypeScript resolution",
      publishableWorkspaces.length > 0,
      publishableWorkspaces.map((workspace) => workspace.name).join(", ") || "no affected public package",
      publishableWorkspaces.length > 0
        ? ["pnpm", ...publishableWorkspaces.flatMap((workspace) => ["--filter", workspace.name]), "exec", "attw", "--pack", "--ignore-rules", "cjs-resolves-to-esm", "internal-resolution-error", "--exclude-entrypoints", "./styles.css", "./src/styles.css", "./dist/styles/*", "./styles/*"]
        : null,
    ),
  ];

  return { files: normalizedFiles, full, fullReason, scope, base, tasks };
}

export function changedFiles(options = {}, diffFilter = "ACMR") {
  if (process.env.GATE_FILES) return normalizeFiles(process.env.GATE_FILES.split(/[\n,]/));
  if (process.env.CI === "true") {
    const base = process.env.GATE_BASE_REF;
    if (options.full && !base) return [];
    if (!base) throw new Error("GATE_BASE_REF is required in CI");
    const head = process.env.GATE_HEAD_REF ?? "HEAD";
    return normalizeFiles(gitLines(["diff", "--name-only", `--diff-filter=${diffFilter}`, `${base}...${head}`]));
  }
  return normalizeFiles(gitLines(["diff", "--cached", "--name-only", `--diff-filter=${diffFilter}`]));
}

function displayCommand(command) {
  return command.map((part) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
}

function printPlan(plan) {
  console.log(`Gate scope: ${plan.full ? `full (${plan.fullReason})` : plan.scope}`);
  console.log(`Changed files: ${plan.files.length}`);
  for (const file of plan.files) console.log(`  ${file}`);
  console.log("\nSelected checks:");
  for (const selected of plan.tasks.filter((candidate) => candidate.selected)) {
    console.log(`  ✓ ${selected.label} — ${selected.reason}`);
    console.log(`    ${displayCommand(selected.command)}`);
  }
  console.log("\nSkipped checks:");
  for (const skipped of plan.tasks.filter((candidate) => !candidate.selected)) console.log(`  – ${skipped.label} — ${skipped.reason}`);
}

function run(plan) {
  printPlan(plan);
  for (const selected of plan.tasks.filter((candidate) => candidate.selected)) {
    console.log(`\n==> ${selected.label}`);
    const result = spawnSync(selected.command[0], selected.command.slice(1), {
      cwd: repositoryRoot,
      env: { ...process.env, ...selected.env },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  console.log("\nSmart gate passed.");
}

export function parseArguments(argv) {
  const full = argv.includes("--full");
  const unknown = argv.filter((argument) => argument !== "--" && argument !== "--full");
  if (unknown.length > 0) throw new Error(`Unknown gate argument: ${unknown.join(", ")}`);
  return { full };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const files = changedFiles(options);
    const addedFiles = changedFiles(options, "A");
    const scope = process.env.CI === "true" ? "merge-base to HEAD" : "staged";
    run(createGatePlan(files, { ...options, addedFiles, scope }));
  } catch (error) {
    console.error(`Gate setup failed: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
}

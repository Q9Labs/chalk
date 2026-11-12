#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { requireRegistered } from "./register.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoots = ["apps", "infrastructure", "packages", "sdks/typescript", "tools"];
const sourceExtensions = new Set([".cjs", ".ex", ".exs", ".go", ".js", ".jsx", ".kt", ".mjs", ".ts", ".tsx"]);
const formatExtensions = new Set([".css", ".html", ".js", ".json", ".jsonc", ".jsx", ".md", ".mdx", ".mjs", ".ts", ".tsx", ".yaml", ".yml"]);
const dependencyBasenames = new Set(["go.mod", "go.sum", "mix.exs", "mix.lock", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
const gateDefinitionPaths = new Set(["package.json", "pnpm-workspace.yaml"]);
// q9gate matches these by basename and directory anywhere in the tree. The CI job selection matches the same names,
// except for the data files below, which only the always-selected checks lane reads.
const gateDefinitionNames = new Set([".dependency-cruiser.cjs", "gate.config.ts", "lefthook.yml", "turbo.json"]);
const gateDefinitionDirectories = [".github/workflows/", "scripts/gates/"];
const gateDataFiles = new Set([".fallowrc.json", "scripts/gates/design-tokens-baseline.json"]);
// A pull request treats only these workflows as gate behavior: the Gate itself and the cache warm-up it starts from. The release,
// proof and publish workflows change no lane's inputs; the graph tests and the release contracts check them.
const gateWorkflowFiles = new Set([".github/workflows/gate.yml", ".github/workflows/cache-warm.yml"]);
const workflowGraphRoots = [".github/workflows", "features/scorecard"];
// The Sync modules the entry and Leave model anchors to, and the model itself. Keep in step with the coverage record in the sync-entry-leave-formal skill.
const formalSyncPaths = [
  "apps/sync/lib/chalk_sync/stateholder/postgres/join_seats.ex",
  "apps/sync/lib/chalk_sync/stateholder/postgres/lifecycle.ex",
  "apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_planner.ex",
  "apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_planner.ex",
  "apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_finalizer.ex",
  "apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_finalizer.ex",
  "apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_claims.ex",
  "apps/sync/lib/chalk_sync/external_operation_consumer.ex",
  "apps/sync/lib/chalk_sync/stateholder/postgres.ex",
  "tools/formal/sync-entry-leave",
  "tools/formal/tla2tools.sh",
];
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
// API config tests and the recorder tests read env and Terraform files here, and the Sync gate runs the managed-episode
// proof validator. No workspace reads them, so they select those gates instead of a full gate.
const deploymentRoots = ["infrastructure/managed-episode", "infrastructure/nightly"];
// Their tests drive a real browser, so CI runs them in their own job with the browser installed.
const browserTestWorkspaceNames = new Set(["web", "@chalk/sdk-web-consumer-e2e"]);
const targetRoots = {
  web: ["web", "@q9labsai/chalk-react", "@chalk/sdk-web-consumer-e2e"],
  mobile: ["@q9labsai/chalk-mobile", "@q9labsai/chalk-react-native"],
};

export class GatePlanningError extends Error {
  constructor(reason, message, { target = null, details = [], suggestion = "pnpm run gate" } = {}) {
    super(message);
    this.name = "GatePlanningError";
    this.reason = reason;
    this.target = target;
    this.details = details;
    this.suggestion = suggestion;
  }
}

function gitLines(args, cwd = repositoryRoot, environment = process.env) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: environment })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) throw new GatePlanningError("invalid-path", "Gate files must be a list of paths");
  const normalized = files.map((file) => {
    if (typeof file !== "string") throw new GatePlanningError("invalid-path", "Gate files must be strings");
    const canonical = file.replaceAll("\\", "/");
    if (!canonical || path.posix.isAbsolute(canonical) || /^[A-Za-z]:\//.test(canonical)) {
      throw new GatePlanningError("invalid-path", `Invalid gate path: ${file}`);
    }
    const segments = canonical.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new GatePlanningError("invalid-path", `Invalid gate path: ${file}`);
    }
    const normalizedPath = path.posix.normalize(canonical);
    if (normalizedPath !== canonical || normalizedPath === ".") {
      throw new GatePlanningError("invalid-path", `Invalid gate path: ${file}`);
    }
    return normalizedPath;
  });
  return [...new Set(normalized)].sort();
}

function isDocumentation(file) {
  return file.startsWith("scratchpad/") || [".md", ".mdx", ".txt"].includes(path.extname(file));
}

// A test file cannot change what the call page ships or what the dashboard engine drives.
function isTestFile(file) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) || /_test\.(?:go|exs?)$/u.test(file) || /(?:^|\/)apps\/sync\/test\//u.test(file);
}

function isExistingFile(file, root = repositoryRoot) {
  return existsSync(path.join(root, file));
}

function startsWithAny(file, prefixes) {
  return prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));
}

// narrow is true only for a pull request. The merge queue and local runs keep the wider rules, so a commit that lands has
// passed everything the Gate ran before this narrowing existed.
function isGateDefinition(file, narrow) {
  if (gateDataFiles.has(file)) return false;
  if (narrow && isDocumentation(file)) return false;
  if (narrow && file.startsWith(".github/workflows/")) return gateWorkflowFiles.has(file);
  return gateDefinitionPaths.has(file) || gateDefinitionNames.has(path.posix.basename(file)) || gateDefinitionDirectories.some((directory) => file.startsWith(directory) || file.includes(`/${directory}`));
}

function isSyncReliabilityInput(file) {
  return (
    startsWithAny(file, ["apps/sync", "apps/api/db/migrations", "packages/whiteboard", "sdks/typescript/client/src/sync", "sdks/typescript/client/src/whiteboard"]) ||
    ["sdks/typescript/client/src/generated/sync.ts", "sdks/typescript/client/src/generated/whiteboard-v1.ts", "sdks/typescript/client/scripts/real-browser-sync.mjs", "contract/schema/sync-v1.json", "contract/schema/whiteboard-v1.json"].includes(file) ||
    file.startsWith("contract/schema/fixtures/sync-v1/")
  );
}

function isKnownPath(file, workspaces, narrow) {
  if (isGateDefinition(file, narrow)) return true;
  // No lane reads these, so a full gate would run the same lanes as the always-on ones.
  if (narrow && (startsWithAny(file, ["infrastructure/observability"]) || file === "e2e.config.ts")) return true;
  if (isDocumentation(file) || workspaces.some((workspace) => startsWithAny(file, [workspace.directory]))) return true;
  if (startsWithAny(file, ["apps/api", "features/mcp", "features/media/sfu", "features/scorecard", "perf", "apps/sync", "contract", "docs", "scripts", "infrastructure/recorder", ...deploymentRoots])) return true;
  if (file.startsWith(".github/") || file.startsWith(".agents/")) return true;
  if (["CHANGELOG.md", "LICENSE", "README.md", "cspell.json", "lefthook.yml", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json"].includes(file)) return true;
  return [".gitignore", ".gitleaks.toml", ".gitleaksignore", ".npmrc", ".oxfmtrc.json", ".fallowrc.json"].includes(file);
}

function workspaceManifestPaths(root, snapshot = { mode: "worktree" }, environment = process.env) {
  let manifests;
  if (snapshot.mode === "ref") {
    manifests = gitLines(["ls-tree", "-r", "--name-only", snapshot.ref], root, environment);
  } else {
    manifests = gitLines(snapshot.mode === "index" ? ["ls-files", "--cached"] : ["ls-files"], root, environment);
  }
  return manifests.filter((manifest) => {
    const directory = path.posix.dirname(manifest);
    return manifest.endsWith("/package.json") && workspaceRoots.some((workspaceRoot) => startsWithAny(directory, [workspaceRoot]));
  });
}

function readWorkspaceManifest(root, manifest, snapshot, environment = process.env) {
  try {
    if (snapshot.mode === "ref") return execFileSync("git", ["show", `${snapshot.ref}:${manifest}`], { cwd: root, encoding: "utf8", env: environment });
    if (snapshot.mode === "index") return execFileSync("git", ["show", `:${manifest}`], { cwd: root, encoding: "utf8", env: environment });
    return readFileSync(path.join(root, manifest), "utf8");
  } catch (error) {
    throw new GatePlanningError("workspace-metadata", `Unable to read workspace manifest ${manifest}`, {
      details: [error instanceof Error ? error.message : String(error)],
    });
  }
}

function parseWorkspaceManifest(manifest, contents) {
  let packageJson;
  try {
    packageJson = JSON.parse(contents);
  } catch (error) {
    throw new GatePlanningError("workspace-metadata", `Malformed workspace manifest: ${manifest}`, {
      details: [error instanceof Error ? error.message : String(error)],
    });
  }
  if (packageJson === null || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    throw new GatePlanningError("workspace-metadata", `Malformed workspace manifest: ${manifest}`);
  }
  if (typeof packageJson.name !== "string" || !packageJson.name) {
    throw new GatePlanningError("workspace-metadata", `Workspace manifest ${manifest} has no package name`);
  }
  const scripts = packageJson.scripts ?? {};
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts) || Object.values(scripts).some((value) => typeof value !== "string")) {
    throw new GatePlanningError("workspace-metadata", `Workspace manifest ${manifest} has malformed scripts`);
  }
  const dependencies = [];
  const dependencySpecs = [];
  for (const field of dependencyFields) {
    const values = packageJson[field];
    if (values === undefined) continue;
    if (values === null || typeof values !== "object" || Array.isArray(values)) {
      throw new GatePlanningError("workspace-metadata", `Workspace manifest ${manifest} has malformed ${field}`);
    }
    for (const [name, spec] of Object.entries(values)) {
      if (typeof spec !== "string") {
        throw new GatePlanningError("workspace-metadata", `Workspace manifest ${manifest} has malformed ${field}.${name}`);
      }
      dependencies.push(name);
      dependencySpecs.push({ name, spec });
    }
  }
  return {
    name: packageJson.name,
    directory: path.posix.dirname(manifest),
    scripts,
    dependencies: [...new Set(dependencies)],
    dependencySpecs,
    isPublic: packageJson.private !== true,
  };
}

export function discoverWorkspaces(root = repositoryRoot, options = {}) {
  const snapshot = options.snapshot ?? (options.mode ? options : { mode: "worktree" });
  const environment = options.environment ?? process.env;
  const manifests = workspaceManifestPaths(root, snapshot, environment);
  const workspaces = manifests.map((manifest) => parseWorkspaceManifest(manifest, readWorkspaceManifest(root, manifest, snapshot, environment)));
  const names = new Set();
  for (const workspace of workspaces) {
    if (names.has(workspace.name)) {
      throw new GatePlanningError("workspace-metadata", `Duplicate workspace name: ${workspace.name}`);
    }
    names.add(workspace.name);
  }
  for (const workspace of workspaces) {
    for (const dependency of workspace.dependencySpecs) {
      if (dependency.spec.startsWith("workspace:") && !names.has(dependency.name)) {
        throw new GatePlanningError("workspace-metadata", `Unresolved workspace dependency: ${workspace.name} -> ${dependency.name}`);
      }
    }
  }
  return workspaces.map(({ dependencySpecs, ...workspace }) => workspace).sort((left, right) => left.directory.localeCompare(right.directory));
}

function affectedWorkspaces(files, workspaces, selectAll) {
  const selected = new Set(selectAll ? workspaces.map((workspace) => workspace.name) : workspaces.filter((workspace) => files.some((file) => startsWithAny(file, [workspace.directory]) && !isDocumentation(file))).map((workspace) => workspace.name));

  let changed = true;
  while (changed) {
    changed = false;
    for (const workspace of workspaces) {
      if (selected.has(workspace.name) || !(workspace.dependencies ?? []).some((dependency) => selected.has(dependency))) continue;
      selected.add(workspace.name);
      changed = true;
    }
  }
  return workspaces.filter((workspace) => selected.has(workspace.name));
}

function validateWorkspaceCollection(workspaces) {
  if (!Array.isArray(workspaces)) {
    throw new GatePlanningError("workspace-metadata", "Workspace metadata must be a list");
  }
  const names = new Set();
  for (const workspace of workspaces) {
    if (workspace === null || typeof workspace !== "object" || Array.isArray(workspace) || typeof workspace.name !== "string" || !workspace.name || typeof workspace.directory !== "string" || !workspace.directory) {
      throw new GatePlanningError("workspace-metadata", "Malformed workspace metadata");
    }
    if (names.has(workspace.name)) {
      throw new GatePlanningError("workspace-metadata", `Duplicate workspace name: ${workspace.name}`);
    }
    names.add(workspace.name);
    if (workspace.scripts === null || (workspace.scripts !== undefined && (typeof workspace.scripts !== "object" || Array.isArray(workspace.scripts) || Object.values(workspace.scripts).some((value) => typeof value !== "string")))) {
      throw new GatePlanningError("workspace-metadata", `Workspace ${workspace.name} has malformed scripts`);
    }
    if (workspace.dependencies !== undefined && (!Array.isArray(workspace.dependencies) || workspace.dependencies.some((dependency) => typeof dependency !== "string"))) {
      throw new GatePlanningError("workspace-metadata", `Workspace ${workspace.name} has malformed dependencies`);
    }
  }
  return names;
}

function deriveTargetUniverse(target, workspaces) {
  const names = validateWorkspaceCollection(workspaces);
  const roots = targetRoots[target];
  const missing = roots.filter((root) => !names.has(root));
  if (missing.length > 0) {
    throw new GatePlanningError("missing-target-root", `Target ${target} is missing workspace roots`, {
      target,
      details: missing,
      suggestion: "pnpm run gate",
    });
  }
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const universe = new Set(roots);
  const pending = [...roots];
  while (pending.length > 0) {
    const name = pending.pop();
    const workspace = byName.get(name);
    for (const dependency of workspace.dependencies ?? []) {
      if (!names.has(dependency) || universe.has(dependency)) continue;
      universe.add(dependency);
      pending.push(dependency);
    }
  }
  return universe;
}

function normalizeTarget(target) {
  if (target === undefined || target === null) return null;
  if (target !== "web" && target !== "mobile") {
    throw new GatePlanningError("invalid-target", `Unknown shipment target: ${target}`, {
      target: String(target),
      details: ["Supported targets: web, mobile"],
      suggestion: "pnpm run gate",
    });
  }
  return target;
}

function filteredPnpmCommand(workspaces, script, trailingArguments = [], pnpmArguments = []) {
  const runnable = workspaces.filter((workspace) => workspace.scripts?.[script]);
  if (runnable.length === 0) return null;
  return ["pnpm", ...pnpmArguments, ...runnable.flatMap((workspace) => ["--filter", workspace.name]), "run", script, ...trailingArguments];
}

function workspaceBuildCommand(workspaces) {
  const runnable = workspaces.filter((workspace) => workspace.scripts?.build);
  if (runnable.length === 0) return null;
  return ["pnpm", "exec", "turbo", "run", "build", "--force", ...runnable.map((workspace) => `--filter=${workspace.name}...`)];
}

function task(id, label, selected, reason, command, env = {}) {
  requireRegistered(id);
  return { id, label, selected: Boolean(selected && command), reason, command, env };
}

export function createGatePlan(files, options = {}) {
  const normalizedFiles = normalizeFiles(files);
  const snapshot = options.snapshot ?? { mode: "worktree" };
  const workspaces = options.workspaces ?? discoverWorkspaces(options.repositoryRoot ?? repositoryRoot, { snapshot });
  validateWorkspaceCollection(workspaces);
  const explicitFull = options.full === true;
  const target = normalizeTarget(options.target);
  // Selection is narrower on a pull request than in the merge queue. For any change beyond documentation the queue also runs the
  // dashboard engine and the call lanes, so what a pull request skipped is proven before master receives it.
  const narrow = options.event === "pull_request";
  const mergeGroup = options.event === "merge_group";
  const gateDefinition = normalizedFiles.find((file) => isGateDefinition(file, narrow));
  const unknownPath = normalizedFiles.find((file) => !isKnownPath(file, workspaces, narrow));
  const full = explicitFull || Boolean(gateDefinition) || Boolean(unknownPath);
  const fullReason = explicitFull ? "--full requested" : gateDefinition ? `${gateDefinition} changes gate behavior` : unknownPath ? `${unknownPath} is not classified` : null;
  if (target && explicitFull) {
    throw new GatePlanningError("target-with-full", "A shipment target cannot be combined with --full", {
      target,
      suggestion: "pnpm run gate -- --full",
    });
  }
  if (target && full) {
    throw new GatePlanningError("full-required", "This change set cannot be narrowed safely", {
      target,
      details: [fullReason],
      suggestion: "pnpm run gate -- --full",
    });
  }
  const targetDependencyConfiguration = normalizedFiles.find((file) => file === "pnpm-lock.yaml");
  if (target && targetDependencyConfiguration) {
    throw new GatePlanningError("full-required", "Workspace dependency configuration cannot be narrowed", {
      target,
      details: [targetDependencyConfiguration],
      suggestion: "pnpm run gate -- --full",
    });
  }
  const nonDocumentationFiles = normalizedFiles.filter((file) => !isDocumentation(file));
  const dependencyChange = full || normalizedFiles.some((file) => dependencyBasenames.has(path.posix.basename(file)));
  const allJavaScript = full || normalizedFiles.includes("pnpm-lock.yaml") || normalizedFiles.includes("pnpm-workspace.yaml") || normalizedFiles.includes("turbo.json") || normalizedFiles.includes("package.json");
  const affected = affectedWorkspaces(nonDocumentationFiles, workspaces, allJavaScript);
  let selectedWorkspaces = affected;
  let excludedWorkspaces = [];
  if (target) {
    const webUniverse = deriveTargetUniverse("web", workspaces);
    const mobileUniverse = deriveTargetUniverse("mobile", workspaces);
    const oppositeUniverse = target === "web" ? mobileUniverse : webUniverse;
    const selectedUniverse = target === "web" ? webUniverse : mobileUniverse;
    const oppositeExclusive = new Set([...oppositeUniverse].filter((name) => !selectedUniverse.has(name)));
    const directIncompatible = workspaces.filter((workspace) => oppositeExclusive.has(workspace.name) && nonDocumentationFiles.some((file) => startsWithAny(file, [workspace.directory])));
    if (directIncompatible.length > 0) {
      const incompatiblePaths = nonDocumentationFiles.filter((file) => directIncompatible.some((workspace) => startsWithAny(file, [workspace.directory])));
      throw new GatePlanningError("target-mismatch", `Target ${target} is incompatible with directly changed workspaces`, {
        target,
        details: incompatiblePaths,
        suggestion: "pnpm run gate",
      });
    }
    excludedWorkspaces = affected.filter((workspace) => oppositeExclusive.has(workspace.name));
    selectedWorkspaces = affected.filter((workspace) => !oppositeExclusive.has(workspace.name));
  }
  const names = (selection) => selection.map((workspace) => workspace.name).join(", ");
  const selectedNames = names(selectedWorkspaces);
  const unitTestWorkspaces = selectedWorkspaces.filter((workspace) => !browserTestWorkspaceNames.has(workspace.name));
  const browserTestWorkspaces = selectedWorkspaces.filter((workspace) => browserTestWorkspaceNames.has(workspace.name));
  const workspaceConcurrency = `--workspace-concurrency=${options.workspaceConcurrency ?? 1}`;
  // The API's chalksfu conformance tests build and run the SFU from features/media/sfu.
  const isApiInput = (file) => startsWithAny(file, ["apps/api", "features/mcp", "features/media/sfu", ...deploymentRoots]);
  const api = full || nonDocumentationFiles.some(isApiInput);
  const queue = mergeGroup && nonDocumentationFiles.length > 0;
  const shippedFiles = narrow ? nonDocumentationFiles.filter((file) => !isTestFile(file)) : nonDocumentationFiles;
  const dashboardEngine = queue || (narrow ? full || shippedFiles.some(isApiInput) || affectedWorkspaces(shippedFiles, workspaces, allJavaScript).some((workspace) => workspace.name === "web") : api || selectedWorkspaces.some((workspace) => workspace.name === "web"));
  // The refresh proof waits out the real five-minute media-access lifetime. A pull request runs it only for the inputs
  // it exercises; the queue runs it for every change, so master never receives a commit it skipped.
  const dashboardRefresh = narrow
    ? full || nonDocumentationFiles.some((file) => startsWithAny(file, ["apps/web/server", "apps/web/src/lib/dashboard", "apps/web/src/components/dashboard", "apps/web/tests/dashboard", "apps/api/internal/accessgrants", "scripts/gates/with-postgres.sh"]))
    : dashboardEngine;
  const sync = full || nonDocumentationFiles.some((file) => isSyncReliabilityInput(file) || startsWithAny(file, deploymentRoots));
  const contracts = full || api || nonDocumentationFiles.some((file) => startsWithAny(file, ["contract", "scripts/codegen", "scripts/contracts", "tools/contract-fixture-proof", "sdks/typescript/client/src/generated"]));
  // What the call-states page imports (traced from apps/web/src/call-states/main.tsx through vite.aliases.ts) plus the harness that drives it.
  const callUi =
    queue ||
    dependencyChange ||
    shippedFiles.some((file) =>
      startsWithAny(file, [
        "apps/web/src/call-states",
        "apps/web/src/components/space",
        "apps/web/src/components/privacy",
        "apps/web/src/lib",
        "apps/web/src/styles",
        "apps/web/src/styles.css",
        "apps/web/scripts",
        "apps/web/call-states.html",
        "perf/budgets.json",
        "features/scorecard/budgets.mjs",
        "apps/web/vite.aliases.ts",
        "apps/web/vite.call-states.config.ts",
        "apps/web/vite.call-performance.config.ts",
        "sdks/typescript/client",
        "sdks/typescript/react",
        "packages/ui",
        "packages/assets",
        "packages/facehash",
        "packages/whiteboard",
        "packages/transcript-language",
        "packages/recording-presentation",
      ]),
    );
  const recorder = full || nonDocumentationFiles.some((file) => startsWithAny(file, ["infrastructure/recorder", "scripts/recorder", ...deploymentRoots]));
  const proofBundle = full || normalizedFiles.some((file) => startsWithAny(file, ["scripts/prod-proof", "sdks/typescript/client/src"]));
  // The SFU gate also runs for its Markdown: its README and AGENTS.md hold the service contract.
  const sfu = full || normalizedFiles.some((file) => startsWithAny(file, ["features/media/sfu"]));
  const sourceFiles = nonDocumentationFiles.filter((file) => sourceExtensions.has(path.extname(file)) && isExistingFile(file, options.repositoryRoot ?? repositoryRoot));
  const formattedFiles = normalizedFiles.filter((file) => formatExtensions.has(path.extname(file)) && isExistingFile(file, options.repositoryRoot ?? repositoryRoot));
  const publishableWorkspaces = selectedWorkspaces.filter((workspace) => workspace.isPublic && startsWithAny(workspace.directory, ["packages", "sdks/typescript"]));
  // CI runs the API and Sync gates as their own jobs and passes services: "external".
  const servicesExternal = options.services === "external";
  const serviceGates = servicesExternal ? [] : [api ? "apps/api/scripts/gate.sh" : null, sync ? "apps/sync/scripts/reliability-correctness" : null].filter(Boolean);
  const base = options.base ?? "origin/master";
  const scope = options.scope ?? "staged";
  // A changed Fallow configuration is not source, but only a whole-repository audit exercises it.
  const fallowConfigChanged = normalizedFiles.includes(".fallowrc.json");
  const fallowCommand = explicitFull || fallowConfigChanged ? ["pnpm", "run", "static:fallow"] : scope === "staged" ? ["bash", "-lc", "git diff --cached --no-ext-diff --binary | pnpm exec fallow audit --diff-stdin"] : ["pnpm", "exec", "fallow", "audit", "--changed-since", base];
  const formatCommand = formattedFiles.length > 0 ? ["pnpm", "exec", "oxfmt", "--check", ...formattedFiles] : null;
  const astGrepFiles = nonDocumentationFiles.filter((file) => /\.(?:[cm]?[jt]sx?|json|ya?ml)$/u.test(file) && isExistingFile(file, options.repositoryRoot ?? repositoryRoot));
  const astGrepCommand = explicitFull || (full && scope !== "staged") ? ["node", "scripts/gates/ast-grep.mjs"] : astGrepFiles.length > 0 ? ["node", "scripts/gates/ast-grep.mjs", ...astGrepFiles] : null;
  const workflowGraph = full || normalizedFiles.some((file) => startsWithAny(file, workflowGraphRoots));
  const registerInputs = full || normalizedFiles.some((file) => startsWithAny(file, [".github/workflows", "scripts/gates", "perf/budgets.json", "gate.config.ts", "lefthook.yml"]));
  const formalSync = full || normalizedFiles.some((file) => startsWithAny(file, formalSyncPaths));
  const typePolicy = full || dependencyChange || nonDocumentationFiles.some((file) => /\.(?:[cm]?ts|tsx)$/u.test(file) || /(?:^|\/)tsconfig[^/]*\.json$/u.test(file));
  // The ratchet counts every JavaScript and TypeScript test file. Edits to scripts/gates select the full gate, so its baseline is covered.
  const mockCallInputs = full || dependencyChange || nonDocumentationFiles.some((file) => /(?:\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|\/)__tests__\/.*\.[cm]?[jt]sx?)$/u.test(file));
  const reactTokens = full || dependencyChange || nonDocumentationFiles.some((file) => startsWithAny(file, ["sdks/typescript/react", "packages/ui/src/styles"]));
  const nativeQuality = full || dependencyChange || nonDocumentationFiles.some((file) => startsWithAny(file, ["sdks/typescript/react-native"]));
  const tasks = [
    task("self-test", "Test network isolation and gate selection", true, "always required", [
      "node",
      "scripts/test/run.mjs",
      "node",
      "--test",
      "scripts/test/no-network.test.mjs",
      "scripts/gates/chalk-gate-plan.test.mjs",
      "scripts/gates/feature-map.test.mjs",
      "scripts/gates/ast-grep.test.mjs",
      "scripts/gates/mock-calls.test.mjs",
    ]),
    task("feature-map", "Feature map coverage", true, "always required", ["node", "scripts/gates/feature-map.mjs"]),
    task("workflow-graph", "Workflow graph tests", workflowGraph, workflowGraph ? "workflow or scorecard inputs changed" : "no workflow or scorecard inputs changed", [
      "node",
      "scripts/test/run.mjs",
      "node",
      "--test",
      "features/scorecard/promote-graph.test.mjs",
      "features/scorecard/nightly-graph.test.mjs",
      "features/scorecard/lease-arguments.test.mjs",
    ]),
    task("register", "Checks register is complete", registerInputs, registerInputs ? "workflow, gate, hook or budget inputs changed" : "no check inputs changed", ["bash", "-c", "node scripts/gates/check-register.mjs && node scripts/test/run.mjs node --test scripts/gates/check-register.test.mjs"]),
    task("hygiene", "Repository hygiene", true, "always required", ["pnpm", "run", "gate:hygiene"]),
    task("secrets", "Secret scan", true, "always required for the selected diff", ["bash", "scripts/gates/gitleaks.sh"], { GATE_SCOPE: explicitFull ? "full" : scope, GITLEAKS_BASE_REF: base }),
    task("generated", "Generated files are current", true, "always required", ["pnpm", "run", "check:generated"]),
    task("format", "Formatting", Boolean(formatCommand), full ? fullReason : `${formattedFiles.length} changed formattable file(s)`, formatCommand),
    task("fallow", "Changed-code analysis", full || sourceFiles.length > 0 || fallowConfigChanged, full ? fullReason : fallowConfigChanged ? ".fallowrc.json changed" : `${sourceFiles.length} source file(s) changed`, fallowCommand),
    task("ast-grep", "Structural security and quality rules", Boolean(astGrepCommand), full ? fullReason : `${astGrepFiles.length} relevant file(s) changed`, astGrepCommand),
    task("formal-sync", "Sync entry and Leave model check", formalSync, formalSync ? "Sync entry or Leave inputs changed" : "Sync entry and Leave are unaffected", ["bash", "tools/formal/sync-entry-leave/run.sh"]),
    task("osv", "Dependency vulnerability scan", dependencyChange, dependencyChange ? "dependency inputs changed" : "no dependency inputs changed", ["bash", "scripts/gates/osv-scanner.sh"]),
    task(
      "services",
      "Service-backed API and Sync correctness gates",
      serviceGates.length > 0,
      serviceGates.length > 0 ? serviceGates.join(" and ") : servicesExternal ? "API and Sync run as separate CI jobs" : "API and Sync are unaffected",
      serviceGates.length > 0 ? ["bash", "scripts/gates/with-postgres.sh", ...serviceGates] : null,
    ),
    task("contracts", "Contract and generated SDK drift", contracts, contracts ? "contract producers or consumers changed" : "contracts are unaffected", ["pnpm", "run", "contract:check"]),
    task("syncpack", "Workspace dependency policy", dependencyChange, dependencyChange ? "workspace dependency inputs changed" : "workspace dependency inputs are unchanged", ["pnpm", "run", "deps:syncpack"]),
    task("types", "Affected workspace type checks", selectedWorkspaces.length > 0, selectedNames || "no affected workspace", filteredPnpmCommand(selectedWorkspaces, "check-types", [], [workspaceConcurrency, "--sort"])),
    task("explicit-any", "TypeScript any policies", typePolicy, typePolicy ? "TypeScript or dependency inputs changed" : "TypeScript is unaffected", ["bash", "-c", "node scripts/gates/implicit-any.mjs && node scripts/gates/explicit-any.mjs"]),
    task("mock-calls", "Assertions on mock calls may only shrink", mockCallInputs, mockCallInputs ? "test files or dependency inputs changed" : "test files are unaffected", ["node", "scripts/gates/mock-calls.mjs"], { GATE_BASE_REF: base }),
    task("react-tokens", "React design-token reach", reactTokens, reactTokens ? "React design-token inputs changed" : "React design tokens are unaffected", ["node", "sdks/typescript/react/scripts/check-token-reach.mjs"]),
    task("native-quality", "React Native design tokens and worklets", nativeQuality, nativeQuality ? "React Native inputs changed" : "React Native is unaffected", [
      "bash",
      "-c",
      "cd sdks/typescript/react-native && node scripts/check-tokenized-styles.mjs && node scripts/check-worklet-directives.mjs",
    ]),
    task("tests", "Selected runtime regression tests", unitTestWorkspaces.length > 0, names(unitTestWorkspaces) || "no affected workspace", filteredPnpmCommand(unitTestWorkspaces, "test", [], [workspaceConcurrency, "--sort"])),
    task("browser-tests", "Affected browser tests", browserTestWorkspaces.length > 0, names(browserTestWorkspaces) || "no affected browser test", filteredPnpmCommand(browserTestWorkspaces, "test")),
    task("dashboard-engine", "Dashboard against the real API and Pages runtime", dashboardEngine, dashboardEngine ? "dashboard or API inputs changed" : "dashboard engine is unaffected", ["bash", "apps/web/tests/dashboard/check-engine.sh", "http"]),
    task("dashboard-refresh", "Owner call across the real media-access lifetime", dashboardRefresh, dashboardRefresh ? "refresh inputs changed, or the merge queue" : "the dashboard refresh proof is unaffected", ["bash", "apps/web/tests/dashboard/check-engine.sh", "refresh"]),
    task("build", "Affected workspace builds", selectedWorkspaces.length > 0, selectedNames || "no affected workspace", workspaceBuildCommand(selectedWorkspaces)),
    task("call-performance", "Call performance budgets", callUi, "call rendering inputs or full gate", ["node", "apps/web/scripts/check-call-performance.mjs", "--gate", "--bundle-only"]),
    task("call-leaks", "Call lifecycle leak budgets", callUi, "call lifecycle inputs or full gate", [
      "node",
      "apps/web/scripts/check-call-performance.mjs",
      "--gate",
      "--leaks-only",
      "--out",
      process.env.GATE_LANE_GROUP?.startsWith("call-leaks-") ? `artifacts/${process.env.GATE_LANE_GROUP}.json` : "artifacts/call-leaks.json",
      ...(process.env.GATE_LANE_GROUP?.startsWith("call-leaks-") ? ["--shard", `${process.env.GATE_LANE_GROUP.slice("call-leaks-".length)}/3`] : []),
    ]),
    task("recorder", "Recorder infrastructure", recorder, recorder ? "recorder inputs changed" : "no recorder inputs changed", ["pnpm", "run", "recorder:gate"]),
    task("proof-bundle", "Proof bundle builds against the Leave baseline client", proofBundle, proofBundle ? "proof or client inputs changed" : "proof bundles are unaffected", ["node", "--test", "scripts/prod-proof/sdk-bundle.test.mjs"]),
    task("sfu", "SFU service Go module", sfu, sfu ? "SFU inputs changed" : "no SFU inputs changed", ["bash", "features/media/sfu/scripts/gate.sh"]),
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

  const source = options.source ?? (["merge base to HEAD", "ci"].includes(scope) ? "ci" : scope === "explicit" ? "explicit" : "staged");
  const mode = full ? "full" : target ? "targeted" : "automatic";
  return {
    files: normalizedFiles,
    full,
    fullReason,
    scope,
    base,
    mode,
    source,
    target,
    selectedWorkspaces,
    excludedWorkspaces,
    services: { api, sync },
    tasks,
  };
}

export function resolveGateTarget(environmentTarget, flagTarget) {
  if (environmentTarget && flagTarget && environmentTarget !== flagTarget) throw new Error("GATE_TARGET and --target must match");
  return environmentTarget ?? flagTarget;
}

function snapshotForScope(scope) {
  if (scope === "staged") return { mode: "index" };
  if (scope === "branch") return { mode: "ref", ref: "HEAD" };
  return { mode: "worktree" };
}

function workspaceConcurrencyFrom(value) {
  if (value === undefined) return 1;
  if (!/^[1-9]\d*$/u.test(value)) throw new GatePlanningError("invalid-concurrency", `GATE_WORKSPACE_CONCURRENCY must be a positive integer, not ${value}`);
  return Number(value);
}

export function gatePlanOptions(context, environment = process.env) {
  return {
    // q9gate marks every workflow file as gate behavior. The planner decides that itself, so a pull request that edits a release workflow keeps its narrow lanes.
    full: context.scope === "full",
    scope: context.scope === "branch" ? "merge base to HEAD" : "staged",
    base: context.base ?? environment.GATE_BASE_REF ?? "origin/master",
    target: resolveGateTarget(environment.GATE_TARGET, context.target),
    event: environment.GATE_EVENT,
    services: environment.GATE_SERVICES === "external" ? "external" : "local",
    snapshot: snapshotForScope(context.scope),
    workspaceConcurrency: workspaceConcurrencyFrom(environment.GATE_WORKSPACE_CONCURRENCY),
  };
}

export function laneEnvironment(laneId, taskEnv, changedFiles, explicitFiles) {
  const env = Object.entries(taskEnv).map(([name, value]) => ({ name, value }));
  if (laneId === "secrets" && explicitFiles) env.push({ name: "GATE_EXPLICIT_FILES", value: changedFiles.join("\n") });
  return env;
}

export function laneResult(laneId, result) {
  if (!result.failed) return { status: "passed" };
  const message = [result.stdout, result.stderr].filter(Boolean).join("\n") || `${laneId} failed`;
  return { status: "failed", findings: [{ file: "gate.config.ts", rule: laneId, message }] };
}

export function emptyScopeResult(context, environment = process.env) {
  if (context.allChangedFiles.length > 0 || context.scope === "full" || environment.GATE_ALLOW_EMPTY === "1") return { status: "passed" };
  const used = context.scope === "branch" ? `branch scope against ${context.base ?? "the base ref"}` : `${context.scope} scope`;
  const message = [
    `Nothing is in scope (${used}), so every lane was skipped. This is not a pass.`,
    "Stage your changes, or pick another scope: `pnpm run gate -- --base origin/master` (branch), `pnpm run gate -- --files <path>`, or `pnpm run gate:full`.",
    "Set GATE_ALLOW_EMPTY=1 only when an empty scope is intended.",
  ].join("\n");
  return { status: "failed", findings: [{ file: "gate.config.ts", rule: "scope", message }] };
}

// CI runs the root gate as one job per lane group. Lanes that no group names run in the checks job, so a new lane
// cannot drop out of CI.
const rootLaneGroups = {
  "browser-tests": ["browser-tests"],
  "dashboard-engine": ["dashboard-engine"],
  "dashboard-refresh": ["dashboard-refresh"],
  // The SFU lane alone took 176 of the 408 seconds the checks group ran its lanes in sequence.
  sfu: ["sfu"],
  "call-leaks-1": ["call-leaks"],
  "call-leaks-2": ["call-leaks"],
  "call-leaks-3": ["call-leaks"],
  build: ["call-performance", "build", "publint", "attw"],
};

export function laneGroup(laneId) {
  return Object.keys(rootLaneGroups).find((group) => rootLaneGroups[group].includes(laneId)) ?? "checks";
}

export function laneGroupLanes(lanes, group) {
  if (group === undefined) return lanes;
  if (group !== "checks" && !Object.hasOwn(rootLaneGroups, group)) throw new GatePlanningError("invalid-lane-group", `Unknown lane group: ${group}`);
  return lanes.filter((lane) => (group === "checks" ? laneGroup(lane.id) === group : rootLaneGroups[group].includes(lane.id)));
}

// The checks group always runs; the other root groups and the service gates run only when the plan selects them.
export function ciJobs(files, options = {}) {
  const plan = createGatePlan(files, { scope: "merge base to HEAD", services: "external", ...options });
  const groups = Object.keys(rootLaneGroups).filter((group) => plan.full || plan.tasks.some((task) => task.selected && rootLaneGroups[group].includes(task.id)));
  return { api: plan.services.api, sync: plan.services.sync, rootGroups: ["checks", ...groups] };
}

function changedFiles(base) {
  return gitLines(["diff", "--name-only", `${base}...HEAD`]);
}

// A selection that cannot be planned runs every job in full rather than skipping lanes. full tells the jobs to pass
// --full, because the base that broke the plan would break their own diff too.
function selectCiJobs(base) {
  if (base === "--full") return { ...ciJobs([], { full: true }), full: true };
  try {
    return { ...ciJobs(changedFiles(base), { base, snapshot: { mode: "ref", ref: "HEAD" }, event: process.env.GATE_EVENT }), full: false };
  } catch (error) {
    console.error(`::warning title=Gate job selection failed::Running every gate job in full. Selection against ${base} failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
    return { ...ciJobs([], { full: true }), full: true };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, base] = process.argv.slice(2);
  if (flag !== "--ci-jobs" || !base) {
    console.error("Usage: chalk-gate-plan.mjs --ci-jobs <base-ref|--full>");
    process.exit(2);
  }
  const jobs = selectCiJobs(base);
  console.log(`api=${jobs.api}\nsync=${jobs.sync}\nroot_groups=${JSON.stringify(jobs.rootGroups)}\nfull=${jobs.full}`);
}

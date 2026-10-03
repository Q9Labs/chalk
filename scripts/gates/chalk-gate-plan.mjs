#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoots = ["apps", "infrastructure", "packages", "sdks/typescript", "tools"];
const sourceExtensions = new Set([".cjs", ".ex", ".exs", ".go", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const formatExtensions = new Set([".css", ".html", ".js", ".json", ".jsonc", ".jsx", ".md", ".mdx", ".mjs", ".ts", ".tsx", ".yaml", ".yml"]);
const dependencyBasenames = new Set(["go.mod", "go.sum", "mix.exs", "mix.lock", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
const gateDefinitionPaths = new Set([".dependency-cruiser.cjs", ".fallowrc.json", "gate.config.ts", "lefthook.yml", "package.json", "pnpm-workspace.yaml", "turbo.json", ".github/workflows/ci.yml"]);
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
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

function isExistingFile(file, root = repositoryRoot) {
  return existsSync(path.join(root, file));
}

function startsWithAny(file, prefixes) {
  return prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));
}

function isGateDefinition(file) {
  return gateDefinitionPaths.has(file) || file.startsWith(".github/workflows/") || file.startsWith("scripts/gates/");
}

function isSyncReliabilityInput(file) {
  return startsWithAny(file, ["apps/sync", "packages/whiteboard", "sdks/typescript/client/src/sync", "sdks/typescript/client/src/whiteboard"]) || file === "contract/schema/sync-v1.json" || file === "contract/schema/whiteboard-v1.json" || file.startsWith("contract/schema/fixtures/sync-v1/");
}

function isKnownPath(file, workspaces) {
  if (isGateDefinition(file)) return true;
  if (isDocumentation(file) || workspaces.some((workspace) => startsWithAny(file, [workspace.directory]))) return true;
  if (startsWithAny(file, ["apps/api", "apps/sync", "contract", "docs", "scripts", "infrastructure/architecture-worker", "infrastructure/recorder"])) return true;
  if (file.startsWith(".github/") || file.startsWith(".agents/") || file.startsWith(".semgrep/")) return true;
  if (["architecture.html", "CHANGELOG.md", "LICENSE", "README.md", "cspell.json", "lefthook.yml", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json"].includes(file)) return true;
  return [".gitignore", ".gitleaks.toml", ".npmrc", ".oxfmtrc.json", ".fallowrc.json"].includes(file);
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
  return { id, label, selected: Boolean(selected && command), reason, command, env };
}

export function createGatePlan(files, options = {}) {
  const normalizedFiles = normalizeFiles(files);
  const snapshot = options.snapshot ?? { mode: "worktree" };
  const workspaces = options.workspaces ?? discoverWorkspaces(options.repositoryRoot ?? repositoryRoot, { snapshot });
  validateWorkspaceCollection(workspaces);
  const explicitFull = options.full === true;
  const target = normalizeTarget(options.target);
  const gateDefinition = normalizedFiles.find(isGateDefinition);
  const unknownPath = normalizedFiles.find((file) => !isKnownPath(file, workspaces));
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
  const selectedNames = selectedWorkspaces.map((workspace) => workspace.name).join(", ");
  const api = full || nonDocumentationFiles.some((file) => startsWithAny(file, ["apps/api"]));
  const sync = full || nonDocumentationFiles.some(isSyncReliabilityInput);
  const contracts = full || api || nonDocumentationFiles.some((file) => startsWithAny(file, ["contract", "packages/diagnostics-contracts", "scripts/codegen", "scripts/contracts", "tools/contract-fixture-proof", "sdks/typescript/client/src/generated"]));
  const architecture = full || nonDocumentationFiles.some((file) => file === "architecture.html" || startsWithAny(file, ["infrastructure/architecture-worker", "packages/assets/src/logos", "scripts/architecture-worker"]));
  const recorder = full || nonDocumentationFiles.some((file) => startsWithAny(file, ["infrastructure/recorder", "scripts/recorder"]));
  const imageSizePatch = full || nonDocumentationFiles.some((file) => file === "scripts/security/image-size-patch.test.mjs" || file === "patches/image-size@2.0.2.patch");
  const sourceFiles = nonDocumentationFiles.filter((file) => sourceExtensions.has(path.extname(file)) && isExistingFile(file, options.repositoryRoot ?? repositoryRoot));
  const formattedFiles = normalizedFiles.filter((file) => formatExtensions.has(path.extname(file)) && isExistingFile(file, options.repositoryRoot ?? repositoryRoot));
  const publishableWorkspaces = selectedWorkspaces.filter((workspace) => workspace.isPublic && startsWithAny(workspace.directory, ["packages", "sdks/typescript"]));
  // CI runs the API and Sync gates as their own jobs and passes services: "external".
  const servicesExternal = options.services === "external";
  const serviceGates = servicesExternal ? [] : [api ? "apps/api/scripts/gate.sh" : null, sync ? "apps/sync/scripts/reliability-correctness" : null].filter(Boolean);
  const base = options.base ?? "origin/master";
  const scope = options.scope ?? "staged";
  const fallowCommand = explicitFull ? ["pnpm", "run", "static:fallow"] : scope === "staged" ? ["bash", "-lc", "git diff --cached --no-ext-diff --binary | pnpm exec fallow audit --diff-stdin"] : ["pnpm", "exec", "fallow", "audit", "--changed-since", base];
  const formatCommand = formattedFiles.length > 0 ? ["pnpm", "exec", "oxfmt", "--check", ...formattedFiles] : null;
  const semgrepCommand = explicitFull || (full && scope !== "staged") ? ["bash", "scripts/gates/semgrep.sh"] : sourceFiles.length > 0 ? ["bash", "scripts/gates/semgrep.sh", ...sourceFiles] : null;
  const tasks = [
    task("self-test", "Gate routing and Sync reliability self-tests", true, "always required", ["node", "--test", "scripts/gates/chalk-gate-plan.test.mjs", "apps/sync/scripts/reliability_harness.test.mjs"]),
    task("language-ratchet", "Language vocabulary ratchet", true, "always required", ["pnpm", "run", "language:ratchet"]),
    task("hygiene", "Repository hygiene", true, "always required", ["pnpm", "run", "gate:hygiene"]),
    task("secrets", "Secret scan", true, "always required for the selected diff", ["bash", "scripts/gates/gitleaks.sh"], { GATE_SCOPE: scope, GITLEAKS_BASE_REF: base }),
    task("generated", "Generated files are current", true, "always required", ["pnpm", "run", "check:generated"]),
    task("architecture", "Architecture Worker", architecture, architecture ? "architecture inputs changed" : "no architecture inputs changed", ["pnpm", "run", "architecture:build"]),
    task("format", "Formatting", Boolean(formatCommand), full ? fullReason : `${formattedFiles.length} changed formattable file(s)`, formatCommand),
    task("fallow", "Changed-code analysis", full || architecture || sourceFiles.length > 0, full ? fullReason : architecture ? "architecture inputs changed" : `${sourceFiles.length} source file(s) changed`, fallowCommand),
    task("semgrep", "Static security rules", Boolean(semgrepCommand), full ? fullReason : `${sourceFiles.length} source file(s) changed`, semgrepCommand),
    task("boundaries", "Workspace import boundaries", full || dependencyChange || sourceFiles.some((file) => [".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"].includes(path.extname(file))), full ? fullReason : "JavaScript/TypeScript source or dependency inputs changed", [
      "pnpm",
      "run",
      "gate:boundaries",
    ]),
    task("osv", "Dependency vulnerability scan", dependencyChange, dependencyChange ? "dependency inputs changed" : "no dependency inputs changed", ["bash", "scripts/gates/osv-scanner.sh"]),
    task(
      "services",
      "Service-backed API and Sync correctness gates",
      serviceGates.length > 0,
      serviceGates.length > 0 ? serviceGates.join(" and ") : servicesExternal ? "API and Sync run as separate CI jobs" : "API and Sync are unaffected",
      serviceGates.length > 0 ? ["bash", "scripts/gates/with-postgres.sh", ...serviceGates] : null,
    ),
    task("contracts", "Contract and generated SDK drift", contracts, contracts ? "contract producers or consumers changed" : "contracts are unaffected", ["pnpm", "run", "contract:check"]),
    task("image-size", "Patched image-size parser contract", imageSizePatch, imageSizePatch ? "image-size patch or guard changed" : "image-size patch is unaffected", ["pnpm", "run", "security:image-size"]),
    task("syncpack", "Workspace dependency policy", dependencyChange, dependencyChange ? "workspace dependency inputs changed" : "workspace dependency inputs are unchanged", ["pnpm", "run", "deps:syncpack"]),
    task("types", "Affected workspace type checks", selectedWorkspaces.length > 0, selectedNames || "no affected workspace", filteredPnpmCommand(selectedWorkspaces, "check-types", [], ["--workspace-concurrency=1", "--sort"])),
    task("tests", "Affected workspace tests with coverage", selectedWorkspaces.length > 0, selectedNames || "no affected workspace", filteredPnpmCommand(selectedWorkspaces, "test", ["--coverage"], ["--workspace-concurrency=1", "--sort"])),
    task("build", "Affected workspace builds", selectedWorkspaces.length > 0, selectedNames || "no affected workspace", workspaceBuildCommand(selectedWorkspaces)),
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

// CI entry: print which service gates a pull request needs, as lines for $GITHUB_OUTPUT.
export function resolveGateTarget(environmentTarget, flagTarget) {
  if (environmentTarget && flagTarget && environmentTarget !== flagTarget) throw new Error("GATE_TARGET and --target must match");
  return environmentTarget ?? flagTarget;
}

function snapshotForScope(scope) {
  if (scope === "staged") return { mode: "index" };
  if (scope === "branch") return { mode: "ref", ref: "HEAD" };
  return { mode: "worktree" };
}

export function gatePlanOptions(context, environment = process.env) {
  return {
    full: context.scope === "full" || context.classification.fullRequired,
    scope: context.scope === "branch" ? "merge base to HEAD" : "staged",
    base: context.base ?? environment.GATE_BASE_REF ?? "origin/master",
    target: resolveGateTarget(environment.GATE_TARGET, context.target),
    services: environment.GATE_SERVICES === "external" ? "external" : "local",
    snapshot: snapshotForScope(context.scope),
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

function printServiceGates(base) {
  const files = gitLines(["diff", "--name-only", `${base}...HEAD`]);
  const { services } = createGatePlan(files, { scope: "merge base to HEAD", base, snapshot: { mode: "ref", ref: "HEAD" } });
  console.log(`api=${services.api}\nsync=${services.sync}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, base] = process.argv.slice(2);
  if (flag !== "--services" || !base) {
    console.error("Usage: chalk-gate-plan.mjs --services <base-ref>");
    process.exit(2);
  }
  printServiceGates(base);
}

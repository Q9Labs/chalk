#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = "https://registry.npmjs.org/";
const githubRepository = "Q9Labs/chalk";
const releaseRootFiles = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "CHANGELOG.md", ".github/workflows/npm-publish.yml", "scripts/npm-release.mjs", "scripts/npm-release.test.mjs"]);
const attwIgnoreRules = ["cjs-resolves-to-esm", "internal-resolution-error"];
const attwExcludedEntrypoints = ["./styles.css", "./src/styles.css", "./dist/styles/*", "./styles/*"];

export const releasePackages = Object.freeze([
  { directory: "packages/diagnostics-contracts", name: "@q9labsai/diagnostics-contracts", version: "0.1.0" },
  { directory: "packages/assets", name: "@q9labsai/chalk-assets", version: "4.1.2" },
  { directory: "packages/facehash", name: "@q9labsai/facehash", version: "4.1.2" },
  { directory: "packages/ui", name: "@q9labsai/chalk-ui", version: "4.1.2" },
  { directory: "packages/whiteboard", name: "@q9labsai/chalk-whiteboard", version: "4.1.2" },
  { directory: "sdks/typescript/client", name: "@q9labsai/chalk-client", version: "4.1.2" },
  { directory: "sdks/typescript/react", name: "@q9labsai/chalk-react", version: "4.1.2" },
  { directory: "sdks/typescript/react-native", name: "@q9labsai/chalk-react-native", version: "4.1.2" },
]);

const packageByName = new Map(releasePackages.map((releasePackage) => [releasePackage.name, releasePackage]));
export const chalkReleaseVersion = releasePackages.find(({ name }) => name === "@q9labsai/chalk-assets").version;

export function usage() {
  return `Usage:
  pnpm run package:release                 Build, validate, and pack only (default)
  pnpm run package:release -- --publish   Build, validate, and publish after confirmation

Options:
  --dry-run              Keep the default no-publish mode explicit
  --publish              Enable publishing; requires typing the release confirmation
  --skip-install         Skip pnpm install --frozen-lockfile
  --artifact-dir <path>  Use an empty directory outside the repository for tarballs
  --help                 Show this help

The publish mode dispatches the guarded GitHub workflow for npmjs.org. CI publishes
one public package at a time in dependency order with npm provenance. Mobile apps
and recording/transcription packages are not part of this release set. Publish
confirmation includes the exact eight-character commit SHA.`;
}

function selectMode(context, mode) {
  if (context.mode && context.mode !== mode) throw new Error("Choose one mode: --dry-run or --publish");
  context.mode = mode;
  context.options.mode = mode;
}

function parseArtifactDirectory(context, argumentsList, index, argument) {
  const value = argumentsList[index + 1];
  if (!value) throw new Error(`${argument} requires a directory path`);
  if (value.startsWith("--")) throw new Error(`${argument} requires a directory path`);
  context.options.artifactDirectory = value;
  return 1;
}

function parseInlineArtifactDirectory(context, argument) {
  const value = argument.slice(argument.indexOf("=") + 1);
  if (!value) throw new Error(`${argument.split("=")[0]} requires a directory path`);
  context.options.artifactDirectory = value;
  return 0;
}

const argumentHandlers = [
  { matches: (argument) => argument === "--", apply: () => 0 },
  {
    matches: (argument) => argument === "--help" || argument === "-h",
    apply: ({ options }) => {
      options.help = true;
      return 0;
    },
  },
  {
    matches: (argument) => argument === "--dry-run",
    apply: (context) => {
      selectMode(context, "dry-run");
      return 0;
    },
  },
  {
    matches: (argument) => argument === "--publish",
    apply: (context) => {
      selectMode(context, "publish");
      return 0;
    },
  },
  {
    matches: (argument) => argument === "--skip-install",
    apply: ({ options }) => {
      options.skipInstall = true;
      return 0;
    },
  },
  { matches: (argument) => argument === "--artifact-dir" || argument === "--artifact-directory", apply: parseArtifactDirectory },
  { matches: (argument) => argument.startsWith("--artifact-dir=") || argument.startsWith("--artifact-directory="), apply: parseInlineArtifactDirectory },
];

function findArgumentHandler(argument) {
  return argumentHandlers.find(({ matches }) => matches(argument));
}

export function parseArguments(argumentsList) {
  const context = { options: { mode: "dry-run", skipInstall: false, artifactDirectory: null, help: false }, mode: null };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const handler = findArgumentHandler(argument);
    if (!handler) throw new Error(`Unknown option: ${argument}\n\n${usage()}`);
    index += handler.apply(context, argumentsList, index, argument);
  }
  return context.options;
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
}

function gitLines(argumentsList) {
  return execFileSync("git", argumentsList, { cwd: repositoryRoot, encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isInside(parent, child) {
  const relativePath = path.relative(parent, child);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

function releaseSourcePath(relativePath) {
  const normalizedPath = relativePath.replaceAll(path.sep, "/");
  return releaseRootFiles.has(normalizedPath) || releasePackages.some(({ directory }) => normalizedPath === directory || normalizedPath.startsWith(`${directory}/`));
}

export function changedReleaseSources(changedFiles) {
  return changedFiles.filter(releaseSourcePath).sort();
}

export function assertCleanReleaseSources() {
  const changedFiles = [...new Set([...gitLines(["diff", "--name-only", "HEAD"]), ...gitLines(["ls-files", "--others", "--exclude-standard"])])];
  const dirtyFiles = changedReleaseSources(changedFiles);
  if (dirtyFiles.length > 0) {
    throw new Error(`Release sources are not clean. Commit or remove these files before packaging:\n${dirtyFiles.map((file) => `- ${file}`).join("\n")}`);
  }
}

function dependencySections(packageManifest) {
  return ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"].flatMap((section) => Object.entries(packageManifest[section] ?? {}));
}

export function workspaceRangeMatches(range, expectedVersion) {
  const value = String(range);
  if (!value.startsWith("workspace:")) return false;
  const requested = value.slice("workspace:".length).trim();
  if (["", "*", "^", "~"].includes(requested)) return true;
  const version = requested.replace(/^[<>=~^ ]+/, "").split(/[ ,]/, 1)[0];
  return version === expectedVersion;
}

function localDependencies(packageManifest, allowedPackages = packageByName) {
  return dependencySections(packageManifest)
    .filter(([name]) => allowedPackages.has(name))
    .map(([name, range]) => ({ name, range: String(range) }));
}

function packageDependencyNames(packageManifest, packageNames) {
  return localDependencies(packageManifest, packageNames)
    .map(({ name }) => name)
    .filter((name) => packageNames.has(name));
}

function packageDependencyMap(packages, manifests) {
  const packageNames = new Map(packages.map((releasePackage) => [releasePackage.name, releasePackage]));
  const dependencies = new Map();
  for (const releasePackage of packages) {
    const packageManifest = manifests.get(releasePackage.name) ?? {};
    dependencies.set(releasePackage.name, new Set(packageDependencyNames(packageManifest, packageNames)));
  }
  return { packageNames, dependencies };
}

function allDependenciesResolved(name, remaining, dependencies) {
  return [...dependencies.get(name)].every((dependency) => !remaining.has(dependency));
}

function readyPackageNames(remaining, dependencies) {
  return [...remaining].filter((name) => allDependenciesResolved(name, remaining, dependencies)).sort((left, right) => left.localeCompare(right));
}

function nextPackage(ready, remaining) {
  if (ready.length === 0) throw new Error(`Workspace dependency cycle detected among: ${[...remaining].sort().join(", ")}`);
  return ready[0];
}

export function topologicalOrder(packages, manifests = new Map()) {
  const { packageNames, dependencies } = packageDependencyMap(packages, manifests);
  const remaining = new Set(packageNames.keys());
  const order = [];
  while (remaining.size > 0) {
    const next = nextPackage(readyPackageNames(remaining, dependencies), remaining);
    remaining.delete(next);
    order.push(packageNames.get(next));
  }
  return order;
}

function manifestValue(value) {
  return value ?? "missing";
}

function fieldMismatch(field, actual, expected) {
  if (actual === expected) return null;
  return `${field} is ${manifestValue(actual)}, expected ${expected}`;
}

function manifestFieldErrors(releasePackage, packageManifest) {
  return [
    ["name", packageManifest.name, releasePackage.name],
    ["version", packageManifest.version, releasePackage.version],
    ["license", packageManifest.license, "MIT"],
  ]
    .map(([field, actual, expected]) => fieldMismatch(field, actual, expected))
    .filter(Boolean);
}

function privatePackageError(packageManifest) {
  return packageManifest.private === true ? "package is private" : null;
}

function publishedFilesError(packageManifest) {
  return Array.isArray(packageManifest.files) && packageManifest.files.length > 0 ? null : "files must list the published build output";
}

function publishConfigErrors(packageManifest) {
  return [fieldMismatch("publishConfig.access", packageManifest.publishConfig?.access, "public"), fieldMismatch("publishConfig.registry", packageManifest.publishConfig?.registry, registry), privatePackageError(packageManifest), publishedFilesError(packageManifest)].filter(Boolean);
}

function workspaceDependencyError({ name, range }) {
  const expectedVersion = packageByName.get(name).version;
  if (workspaceRangeMatches(range, expectedVersion)) return null;
  return `workspace dependency ${name} uses ${range}, expected a range for ${expectedVersion}`;
}

function workspaceDependencyErrors(packageManifest) {
  return localDependencies(packageManifest).map(workspaceDependencyError).filter(Boolean);
}

function assertPackageManifest(releasePackage, packageManifest) {
  const errors = [...manifestFieldErrors(releasePackage, packageManifest), ...publishConfigErrors(packageManifest), ...workspaceDependencyErrors(packageManifest)];
  if (errors.length > 0) throw new Error(`${releasePackage.directory}/package.json: ${errors.join("; ")}`);
}

export function loadReleaseManifests() {
  const manifests = new Map();
  for (const releasePackage of releasePackages) {
    const manifestPath = path.join(releasePackage.directory, "package.json");
    if (!existsSync(path.join(repositoryRoot, manifestPath))) throw new Error(`Missing package manifest: ${manifestPath}`);
    const packageManifest = readJson(manifestPath);
    assertPackageManifest(releasePackage, packageManifest);
    manifests.set(releasePackage.name, packageManifest);
  }
  return manifests;
}

function assertCommandSucceeded(result, label) {
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

function printCapturedOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function runCommand(command, argumentsList, { capture = false, env = {}, label = `${command} ${argumentsList.join(" ")}` } = {}) {
  process.stdout.write(`\n> ${command} ${argumentsList.join(" ")}\n`);
  const result = spawnSync(command, argumentsList, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  assertCommandSucceeded(result, label);
  if (capture) printCapturedOutput(result);
  return result;
}

function runCaptured(command, argumentsList, env = {}) {
  const result = spawnSync(command, argumentsList, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function registryNotFound(result) {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return ["e404", "404 not found", "is not in this registry"].some((message) => output.includes(message));
}

function registrySuccessVersion(result, releasePackage) {
  const version = result.stdout.trim();
  if (!version) throw new Error(`Registry returned no version for ${releasePackage.name}@${releasePackage.version}`);
  return version;
}

function firstErrorLine(value) {
  return value.trim().split(/\r?\n/)[0] || "unknown registry error";
}

function registryFailure(releasePackage, result) {
  return new Error(`Could not check ${releasePackage.name}@${releasePackage.version} on npm (${firstErrorLine(result.stderr)})`);
}

function registryVersion(releasePackage) {
  const result = runCaptured("npm", ["view", `${releasePackage.name}@${releasePackage.version}`, "version", "--json", "--registry", registry]);
  if (result.status === 0) return registrySuccessVersion(result, releasePackage);
  if (registryNotFound(result)) return null;
  throw registryFailure(releasePackage, result);
}

function assertRegistryVersionsAvailable() {
  for (const releasePackage of releasePackages) {
    const existingVersion = registryVersion(releasePackage);
    if (existingVersion !== null) {
      console.log(`Registry already has ${releasePackage.name}@${releasePackage.version}; the publish workflow will skip it`);
    } else {
      console.log(`Registry available: ${releasePackage.name}@${releasePackage.version}`);
    }
  }
}

function prepareArtifactDirectory(requestedDirectory) {
  const artifactDirectory = requestedDirectory ? path.resolve(repositoryRoot, requestedDirectory) : mkdtempSync(path.join(os.tmpdir(), "chalk-npm-release-"));
  if (isInside(repositoryRoot, artifactDirectory)) throw new Error(`Artifact directory must be outside the repository: ${artifactDirectory}`);
  mkdirSync(artifactDirectory, { recursive: true });
  if (readdirSync(artifactDirectory).length > 0) throw new Error(`Artifact directory must be empty: ${artifactDirectory}`);
  return artifactDirectory;
}

function packageArchive(artifactDirectory, releasePackage) {
  const before = new Set(readdirSync(artifactDirectory));
  runCommand("pnpm", ["--filter", releasePackage.name, "pack", "--pack-destination", artifactDirectory], { label: `pack ${releasePackage.name}` });
  const archives = readdirSync(artifactDirectory)
    .filter((entry) => entry.endsWith(".tgz") && !before.has(entry))
    .map((entry) => path.join(artifactDirectory, entry));
  if (archives.length !== 1 || !statSync(archives[0]).isFile()) throw new Error(`Expected one tarball for ${releasePackage.name}, found ${archives.length}`);
  return archives[0];
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function validateArchive(archivePath) {
  runCommand("pnpm", ["exec", "publint", "run", archivePath], { label: `publint ${path.basename(archivePath)}` });
  runCommand("pnpm", ["exec", "attw", archivePath, "--ignore-rules", ...attwIgnoreRules, "--exclude-entrypoints", ...attwExcludedEntrypoints], { label: `attw ${path.basename(archivePath)}` });
}

function ensureBuiltOutput(releasePackage) {
  const outputDirectory = path.join(repositoryRoot, releasePackage.directory, "dist");
  if (!existsSync(outputDirectory) || readdirSync(outputDirectory).length === 0) throw new Error(`${releasePackage.name} did not produce a non-empty dist directory`);
}

function writeArtifactManifest(artifactDirectory, order, archives) {
  const manifest = {
    generatedAt: new Date().toISOString(),
    revision: gitLines(["rev-parse", "HEAD"])[0],
    registry,
    packages: order.map((releasePackage) => ({
      name: releasePackage.name,
      version: releasePackage.version,
      directory: releasePackage.directory,
      archive: path.basename(archives.get(releasePackage.name)),
      sha256: sha256(archives.get(releasePackage.name)),
    })),
  };
  const manifestPath = path.join(artifactDirectory, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

export function publishConfirmationPhrase(releaseVersion, shortRevision) {
  return `PUBLISH CHALK ${releaseVersion} FROM ${shortRevision}`;
}

async function confirmPublish(releaseVersion, shortRevision) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("--publish requires an interactive terminal so the release confirmation cannot be skipped");
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const confirmationPhrase = publishConfirmationPhrase(releaseVersion, shortRevision);
  try {
    const answer = await prompt.question(`Type ${confirmationPhrase} to publish all packages: `);
    if (answer.trim() !== confirmationPhrase) throw new Error("Publish confirmation did not match; no package was published");
  } finally {
    prompt.close();
  }
}

function remoteMasterLine(output) {
  const line = String(output)
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  if (!line) throw new Error("Live origin/master did not return a valid commit SHA");
  return line;
}

function remoteMasterFields(output) {
  const fields = remoteMasterLine(output).split(/\s+/);
  if (fields.length < 2) throw new Error("Live origin/master did not return a valid commit SHA");
  return fields;
}

function validRemoteSha(value) {
  return /^[0-9a-f]{40}$/i.test(value);
}

function validRemoteMaster(fields) {
  if (!validRemoteSha(fields[0])) return false;
  return fields[1] === "refs/heads/master";
}

export function parseRemoteMasterSha(output) {
  const fields = remoteMasterFields(output);
  if (!validRemoteMaster(fields)) throw new Error("Live origin/master did not return a valid commit SHA");
  return fields[0].toLowerCase();
}

function assertMasterBranch(branch) {
  if (branch !== "master") throw new Error(`Publish dispatch requires the master branch, found ${branch || "detached HEAD"}`);
}

function readLiveMasterRevision() {
  let output;
  try {
    output = execFileSync("git", ["ls-remote", "origin", "refs/heads/master"], { cwd: repositoryRoot, encoding: "utf8" });
  } catch {
    throw new Error("Could not verify the live origin/master commit");
  }
  return parseRemoteMasterSha(output);
}

function assertLocalOriginRevision(localRevision, liveRevision) {
  if (localRevision !== liveRevision) throw new Error(`Local origin/master is stale (local ${localRevision.slice(0, 12)}, live ${liveRevision.slice(0, 12)}); fetch and retry`);
}

function assertReleaseRevision(head, liveRevision) {
  if (head !== liveRevision) throw new Error(`Publish dispatch requires HEAD to equal live origin/master (HEAD ${head.slice(0, 12)}, origin/master ${liveRevision.slice(0, 12)})`);
}

function releaseHead() {
  const branch = gitLines(["branch", "--show-current"])[0];
  assertMasterBranch(branch);
  const head = gitLines(["rev-parse", "HEAD"])[0];
  const originHead = gitLines(["rev-parse", "origin/master"])[0];
  const liveOriginHead = readLiveMasterRevision();
  assertLocalOriginRevision(originHead, liveOriginHead);
  assertReleaseRevision(head, liveOriginHead);
  return { head, shortRevision: head.slice(0, 8) };
}

function assertGitHubAuth() {
  const result = runCaptured("gh", ["auth", "status", "--hostname", "github.com"]);
  if (result.status !== 0) throw new Error("GitHub auth is unavailable. Run gh auth login before --publish.");
  console.log("GitHub auth check passed.");
}

export function publishWorkflowArguments(head) {
  return ["workflow", "run", ".github/workflows/npm-publish.yml", "--repo", githubRepository, "--ref", "master", "-f", "dry_run=false", "-f", `release_sha=${head}`];
}

function dispatchPublishWorkflow(head) {
  runCommand("gh", publishWorkflowArguments(head), { label: "dispatch npm publish workflow" });
  console.log("Workflow dispatched. Follow it with:");
  console.log(`  gh run list --repo ${githubRepository} --workflow .github/workflows/npm-publish.yml --limit 5 --json databaseId,status,conclusion,url,headSha`);
  console.log(`  gh run watch <run-id> --repo ${githubRepository} --exit-status`);
}

function prepareReleasePlan(options) {
  console.log(`Chalk npm release (${options.mode})`);
  assertCleanReleaseSources();
  const manifests = loadReleaseManifests();
  const order = topologicalOrder(releasePackages, manifests);
  console.log(`Publish order: ${order.map(({ name }) => name).join(" -> ")}`);
  assertRegistryVersionsAvailable();
  return order;
}

function installDependencies(skipInstall) {
  if (!skipInstall) runCommand("pnpm", ["install", "--frozen-lockfile"], { label: "pnpm install" });
}

function buildArtifacts(order, artifactDirectory) {
  const archives = new Map();
  for (const releasePackage of order) {
    runCommand("pnpm", ["--filter", releasePackage.name, "run", "build"], { label: `build ${releasePackage.name}` });
    ensureBuiltOutput(releasePackage);
    const archivePath = packageArchive(artifactDirectory, releasePackage);
    validateArchive(archivePath);
    archives.set(releasePackage.name, archivePath);
    console.log(`Validated ${releasePackage.name}@${releasePackage.version}: ${path.basename(archivePath)}`);
  }
  return archives;
}

function finalizeArtifacts(artifactDirectory, order, archives) {
  assertCleanReleaseSources();
  loadReleaseManifests();
  assertRegistryVersionsAvailable();
  const manifestPath = writeArtifactManifest(artifactDirectory, order, archives);
  console.log(`Artifact manifest: ${manifestPath}`);
}

function reportDryRun() {
  console.log("Dry run complete. No npm publish command was run.");
  console.log(`To repeat the guarded build and publish flow later: pnpm run package:release -- --publish`);
}

async function dispatchRelease() {
  const { head, shortRevision } = releaseHead();
  assertGitHubAuth();
  await confirmPublish(chalkReleaseVersion, shortRevision);
  dispatchPublishWorkflow(head);
}

export async function main(argumentsList = process.argv.slice(2)) {
  const options = parseArguments(argumentsList);
  if (options.help) return console.log(usage());
  const order = prepareReleasePlan(options);
  installDependencies(options.skipInstall);
  const artifactDirectory = prepareArtifactDirectory(options.artifactDirectory);
  const archives = buildArtifacts(order, artifactDirectory);
  finalizeArtifacts(artifactDirectory, order, archives);
  if (options.mode === "dry-run") return reportDryRun();
  await dispatchRelease();
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`npm release failed: ${error.message}`);
    process.exitCode = 1;
  });
}

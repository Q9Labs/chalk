#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { gitLines } from "./lib/git.mjs";
import { sha256 } from "./lib/hash.mjs";
import { chalkReleaseVersion, releasePackages } from "./lib/release-packages.mjs";
import { repositoryRoot } from "./lib/repository.mjs";

const registry = "https://registry.npmjs.org/";
const githubRepository = "Q9Labs/chalk";
const releaseRootFiles = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "CHANGELOG.md", ".github/workflows/npm-publish.yml", "scripts/npm-release.mjs", "scripts/lib/release-packages.mjs", "scripts/lib/repository.mjs", ".attw.json"]);

const packageByName = new Map(releasePackages.map((releasePackage) => [releasePackage.name, releasePackage]));

function usage() {
  return `Usage:
  pnpm run package:release                 Build, validate, and pack only (default)
  pnpm run package:release -- --publish   Build, validate, and publish after confirmation
  pnpm run package:release -- --bump 4.2.0 Rewrite versions and the lockfile

Options:
  --dry-run              Keep the default no-publish mode explicit; with --bump, list the files without writing
  --bump <version>       Set the synchronized Chalk release version everywhere, then refresh pnpm-lock.yaml
  --publish              Enable publishing; requires typing the release confirmation
  --skip-install         Skip pnpm install --frozen-lockfile
  --artifact-dir <path>  Use an empty directory outside the repository for tarballs
  --help                 Show this help

The publish mode dispatches the guarded GitHub workflow for npmjs.org. CI publishes
one public package at a time in dependency order with npm provenance. Every public
workspace package is included; private apps and tools are excluded. Publish
confirmation includes the exact eight-character commit SHA.`;
}

function parseArguments(argumentsList) {
  let values;
  try {
    // pnpm forwards the "--" that separates its own flags; parseArgs would read everything after it as positional.
    ({ values } = parseArgs({
      args: argumentsList.filter((argument) => argument !== "--"),
      options: {
        help: { type: "boolean", short: "h" },
        "dry-run": { type: "boolean" },
        publish: { type: "boolean" },
        "skip-install": { type: "boolean" },
        bump: { type: "string" },
        "artifact-dir": { type: "string" },
      },
    }));
  } catch (error) {
    throw new Error(`${error.message}\n\n${usage()}`);
  }
  if (values["dry-run"] && values.publish) throw new Error("Choose one mode: --dry-run or --publish");
  if (values.bump === "") throw new Error("--bump requires a version");
  if (values["artifact-dir"] === "") throw new Error("--artifact-dir requires a directory path");
  return {
    mode: values.publish ? "publish" : "dry-run",
    skipInstall: Boolean(values["skip-install"]),
    artifactDirectory: values["artifact-dir"] ?? null,
    help: Boolean(values.help),
    bump: values.bump ?? null,
    dryRun: Boolean(values["dry-run"]),
  };
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
}

function isInside(parent, child) {
  const relativePath = path.relative(parent, child);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

function releaseSourcePath(relativePath) {
  const normalizedPath = relativePath.replaceAll(path.sep, "/");
  return releaseRootFiles.has(normalizedPath) || releasePackages.some(({ directory }) => normalizedPath === directory || normalizedPath.startsWith(`${directory}/`));
}

function assertCleanReleaseSources() {
  const changedFiles = [...new Set([...gitLines(["diff", "--name-only", "HEAD"]), ...gitLines(["ls-files", "--others", "--exclude-standard"])])];
  const dirtyFiles = changedFiles.filter(releaseSourcePath).sort();
  if (dirtyFiles.length > 0) {
    throw new Error(`Release sources are not clean. Commit or remove these files before packaging:\n${dirtyFiles.map((file) => `- ${file}`).join("\n")}`);
  }
}

function localDependencies(packageManifest) {
  return ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]
    .flatMap((section) => Object.entries(packageManifest[section] ?? {}))
    .filter(([name]) => packageByName.has(name))
    .map(([name, range]) => ({ name, range: String(range) }));
}

function topologicalOrder(manifests) {
  const dependencies = new Map(releasePackages.map(({ name }) => [name, localDependencies(manifests.get(name) ?? {}).map((dependency) => dependency.name)]));
  const remaining = new Set(dependencies.keys());
  const order = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((name) => dependencies.get(name).every((dependency) => !remaining.has(dependency))).sort((left, right) => left.localeCompare(right));
    if (ready.length === 0) throw new Error(`Workspace dependency cycle detected among: ${[...remaining].sort().join(", ")}`);
    remaining.delete(ready[0]);
    order.push(packageByName.get(ready[0]));
  }
  return order;
}

function assertPackageManifest(releasePackage, packageManifest) {
  const mismatch = (field, actual, expected) => (actual === expected ? null : `${field} is ${actual ?? "missing"}, expected ${expected}`);
  const errors = [
    mismatch("name", packageManifest.name, releasePackage.name),
    mismatch("version", packageManifest.version, releasePackage.independent ? releasePackage.version : chalkReleaseVersion),
    mismatch("license", packageManifest.license, "MIT"),
    mismatch("publishConfig.access", packageManifest.publishConfig?.access, "public"),
    mismatch("publishConfig.registry", packageManifest.publishConfig?.registry, registry),
    packageManifest.private === true ? "package is private" : null,
    Array.isArray(packageManifest.files) && packageManifest.files.length > 0 ? null : "files must list the published build output",
    ...localDependencies(packageManifest)
      .filter(({ range }) => !["workspace:^", "workspace:~", "workspace:*"].includes(range))
      .map(({ name, range }) => `workspace dependency ${name} uses ${range}, expected workspace:^ so a release edits no dependent`),
  ].filter(Boolean);
  if (errors.length > 0) throw new Error(`${releasePackage.directory}/package.json: ${errors.join("; ")}`);
}

function loadReleaseManifests() {
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

function registryVersion(releasePackage) {
  const result = runCaptured("npm", ["view", `${releasePackage.name}@${releasePackage.version}`, "version", "--json", "--registry", registry]);
  if (result.status === 0) {
    const version = result.stdout.trim();
    if (!version) throw new Error(`Registry returned no version for ${releasePackage.name}@${releasePackage.version}`);
    return version;
  }
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (["e404", "404 not found", "is not in this registry"].some((message) => output.includes(message))) return null;
  throw new Error(`Could not check ${releasePackage.name}@${releasePackage.version} on npm (${result.stderr.trim().split(/\r?\n/)[0] || "unknown registry error"})`);
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

function validateArchive(archivePath) {
  runCommand("pnpm", ["exec", "publint", "run", archivePath], { label: `publint ${path.basename(archivePath)}` });
  runCommand("pnpm", ["exec", "attw", archivePath, "--config-path", path.join(repositoryRoot, ".attw.json")], { label: `attw ${path.basename(archivePath)}` });
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
      sha256: sha256(readFileSync(archives.get(releasePackage.name))),
    })),
  };
  const manifestPath = path.join(artifactDirectory, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

async function confirmPublish(releaseVersion, shortRevision) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("--publish requires an interactive terminal so the release confirmation cannot be skipped");
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const confirmationPhrase = `PUBLISH CHALK ${releaseVersion} FROM ${shortRevision}`;
  try {
    const answer = await prompt.question(`Type ${confirmationPhrase} to publish all packages: `);
    if (answer.trim() !== confirmationPhrase) throw new Error("Publish confirmation did not match; no package was published");
  } finally {
    prompt.close();
  }
}

function parseRemoteMasterSha(output) {
  const fields = (output.split(/\r?\n/).find((line) => line.trim()) ?? "").trim().split(/\s+/);
  if (fields.length < 2 || !/^[0-9a-f]{40}$/i.test(fields[0]) || fields[1] !== "refs/heads/master") throw new Error("Live origin/master did not return a valid commit SHA");
  return fields[0].toLowerCase();
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

function releaseHead() {
  const branch = gitLines(["branch", "--show-current"])[0];
  if (branch !== "master") throw new Error(`Publish dispatch requires the master branch, found ${branch || "detached HEAD"}`);
  const head = gitLines(["rev-parse", "HEAD"])[0];
  const originHead = gitLines(["rev-parse", "origin/master"])[0];
  const liveOriginHead = readLiveMasterRevision();
  if (originHead !== liveOriginHead) throw new Error(`Local origin/master is stale (local ${originHead.slice(0, 12)}, live ${liveOriginHead.slice(0, 12)}); fetch and retry`);
  if (head !== liveOriginHead) throw new Error(`Publish dispatch requires HEAD to equal live origin/master (HEAD ${head.slice(0, 12)}, origin/master ${liveOriginHead.slice(0, 12)})`);
  return { head, shortRevision: head.slice(0, 8) };
}

function assertGitHubAuth() {
  const result = runCaptured("gh", ["auth", "status", "--hostname", "github.com"]);
  if (result.status !== 0) throw new Error("GitHub auth is unavailable. Run gh auth login before --publish.");
  console.log("GitHub auth check passed.");
}

function publishWorkflowArguments(head) {
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
  const order = topologicalOrder(manifests);
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

const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function bumpManifestText(text, fromVersion, toVersion) {
  const packageManifest = JSON.parse(text);
  const synchronized = releasePackages.some(({ name, independent }) => name === packageManifest.name && !independent);
  return synchronized ? text.replace(`"version": "${fromVersion}"`, `"version": "${toVersion}"`) : text;
}

// Takes a map of relative path to file text for every workspace package.json.
function planVersionBump(files, fromVersion, toVersion) {
  if (!semverPattern.test(toVersion)) throw new Error(`--bump requires a version like 4.2.0, got ${toVersion}`);
  if (toVersion === fromVersion) throw new Error(`Release version is already ${fromVersion}`);
  const changes = new Map();
  for (const [relativePath, text] of files) {
    const next = bumpManifestText(text, fromVersion, toVersion);
    if (next !== text) changes.set(relativePath, next);
  }
  return changes;
}

function readVersionBumpFiles() {
  const manifests = gitLines(["ls-files", "--", "package.json", "**/package.json"]);
  return new Map(manifests.map((relativePath) => [relativePath, readFileSync(path.join(repositoryRoot, relativePath), "utf8")]));
}

function applyVersionBump(changes) {
  for (const [relativePath, text] of changes) writeFileSync(path.join(repositoryRoot, relativePath), text);
  runCommand("pnpm", ["install", "--lockfile-only"], { label: "refresh pnpm-lock.yaml" });
  console.log("Bump applied. Review the diff, then run pnpm run package:release.");
}

function bumpReleaseVersion(toVersion, { dryRun }) {
  const changes = planVersionBump(readVersionBumpFiles(), chalkReleaseVersion, toVersion);
  const note = dryRun ? " (dry run, nothing written)" : "";
  console.log(`Bump ${chalkReleaseVersion} -> ${toVersion}${note}`);
  for (const relativePath of changes.keys()) console.log(`- ${relativePath}`);
  if (!dryRun) applyVersionBump(changes);
}

async function main(argumentsList = process.argv.slice(2)) {
  const options = parseArguments(argumentsList);
  if (options.help) return console.log(usage());
  if (options.bump) return bumpReleaseVersion(options.bump, { dryRun: options.dryRun });
  const order = prepareReleasePlan(options);
  installDependencies(options.skipInstall);
  const artifactDirectory = prepareArtifactDirectory(options.artifactDirectory);
  const archives = buildArtifacts(order, artifactDirectory);
  finalizeArtifacts(artifactDirectory, order, archives);
  if (options.mode === "dry-run") return reportDryRun();
  await dispatchRelease();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`npm release failed: ${error.message}`);
    process.exitCode = 1;
  });
}

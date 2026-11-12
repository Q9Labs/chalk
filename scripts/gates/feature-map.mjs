import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const sourceRoots = ["apps/api/internal", "apps/sync", "sdks/typescript", "packages", "apps/web", "apps/mobile", "infrastructure", ".github/workflows", "docs", "features"];

// This directory contains data-only snapshots, not source packages; its generated identifier stays out of the map.
const dataOnlySubtrees = ["apps/sync/test/fixtures"];

function isWithin(candidate, parent) {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function validRelativePath(candidate) {
  return typeof candidate === "string" && candidate.length > 0 && !candidate.includes("\\") && !path.posix.isAbsolute(candidate) && !path.win32.isAbsolute(candidate) && path.posix.normalize(candidate) === candidate && candidate !== "." && candidate !== ".." && !candidate.startsWith("../");
}

function ignoredPaths(root, paths) {
  if (paths.length === 0 || !fs.existsSync(path.join(root, ".git"))) return new Set();
  const result = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
    cwd: root,
    encoding: "utf8",
    input: `${paths.join("\0")}\0`,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error(`git check-ignore failed: ${result.stderr.trim()}`);
  return new Set(result.stdout.split("\0").filter(Boolean));
}

function listDirectories(root, scanRoots, excludedSubtrees) {
  const directories = [];
  const files = [];
  const errors = [];
  let pendingDirectories = [];

  for (const scanRoot of scanRoots) {
    const absoluteRoot = path.join(root, scanRoot);
    let rootStat;
    try {
      rootStat = fs.statSync(absoluteRoot);
    } catch {
      errors.push(`Source root does not exist: ${scanRoot}`);
      continue;
    }
    if (!rootStat.isDirectory()) {
      errors.push(`Source root is not a directory: ${scanRoot}`);
      continue;
    }

    directories.push(scanRoot);
    pendingDirectories.push(scanRoot);
  }

  while (pendingDirectories.length > 0) {
    const candidatesByDirectory = new Map();
    for (const relativeDirectory of pendingDirectories) {
      if (excludedSubtrees.some((excluded) => relativeDirectory === excluded)) continue;
      const entries = fs.readdirSync(path.join(root, relativeDirectory), { withFileTypes: true });
      candidatesByDirectory.set(relativeDirectory, entries);
    }
    const candidatePaths = [...candidatesByDirectory].flatMap(([relativeDirectory, entries]) => entries.filter((entry) => (entry.isDirectory() || entry.isFile()) && !entry.isSymbolicLink() && entry.name !== "node_modules").map((entry) => path.posix.join(relativeDirectory, entry.name)));
    const ignored = ignoredPaths(root, candidatePaths);
    const nextDirectories = [];
    for (const [relativeDirectory, entries] of candidatesByDirectory) {
      for (const entry of entries) {
        if (entry.isSymbolicLink() || entry.name === "node_modules") continue;
        const relativeEntry = path.posix.join(relativeDirectory, entry.name);
        if (ignored.has(relativeEntry)) continue;
        if (entry.isDirectory()) {
          directories.push(relativeEntry);
          nextDirectories.push(relativeEntry);
        } else if (entry.isFile()) {
          files.push(relativeEntry);
        }
      }
    }
    pendingDirectories = nextDirectories;
  }

  return { directories, files, errors };
}

export function validateFeatureMap(featureMap, options = {}) {
  const root = options.root ?? repositoryRoot;
  const scanRoots = options.roots ?? sourceRoots;
  const excludedSubtrees = options.excludedSubtrees ?? dataOnlySubtrees;
  const errors = [];

  if (featureMap === null || typeof featureMap !== "object" || !Array.isArray(featureMap.features)) {
    return { errors: ["features.json must contain a features array"], directoryCount: 0 };
  }

  const featuresByName = new Map();
  for (const feature of featureMap.features) {
    if (feature === null || typeof feature !== "object" || typeof feature.name !== "string" || !feature.name.trim()) {
      errors.push("Every feature must have a non-empty name");
      continue;
    }
    if (featuresByName.has(feature.name)) {
      errors.push(`Duplicate feature name: ${feature.name}`);
      continue;
    }
    featuresByName.set(feature.name, feature);
    if (typeof feature.summary !== "string" || !feature.summary.trim()) errors.push(`Feature ${feature.name} needs a summary`);
    if (!Array.isArray(feature.paths) || feature.paths.some((entry) => typeof entry !== "string")) {
      errors.push(`Feature ${feature.name} must have a paths array of strings`);
      continue;
    }
  }

  if (!featuresByName.has("shared")) errors.push('features.json must contain an entry named "shared"');

  for (const [name, feature] of featuresByName) {
    if (!Array.isArray(feature.paths)) continue;
    const uniquePaths = new Set();
    for (const relativePath of feature.paths) {
      if (!validRelativePath(relativePath)) {
        errors.push(`Feature ${name} has an invalid relative path: ${String(relativePath)}`);
        continue;
      }
      if (uniquePaths.has(relativePath)) {
        errors.push(`Feature ${name} lists path more than once: ${relativePath}`);
        continue;
      }
      uniquePaths.add(relativePath);

      let stats;
      try {
        stats = fs.statSync(path.join(root, relativePath));
      } catch {
        errors.push(`Feature ${name} path does not exist: ${relativePath}`);
        continue;
      }
    }
  }

  const scan = listDirectories(root, scanRoots, excludedSubtrees);
  errors.push(...scan.errors);
  const claims = [...featuresByName.entries()].flatMap(([name, feature]) => (Array.isArray(feature.paths) ? feature.paths.map((claim) => ({ name, claim })) : []));
  const ownersFor = (relativePath) => new Set(claims.filter(({ claim }) => isWithin(relativePath, claim)).map(({ name }) => name));
  for (const directory of scan.directories) {
    const owners = ownersFor(directory);
    if (owners.size > 3) {
      errors.push(`Directory ${directory} is claimed by ${owners.size} features (${[...owners].join(", ")}); move shared code to the shared entry in features.json.`);
    }
    const hasDescendantClaim = claims.some(({ claim }) => isWithin(claim, directory));
    if (owners.size === 0 && !hasDescendantClaim) errors.push(`Unclaimed source directory: ${directory}. Add this directory to features.json.`);
  }
  for (const file of scan.files) {
    if (ownersFor(file).size === 0) errors.push(`Unclaimed source file: ${file}. Add this file to features.json.`);
  }

  return { errors, directoryCount: scan.directories.length };
}

function ownersForPath(featureMap, relativePath) {
  const exactOwners = featureMap.features.filter((feature) => feature.paths.includes(relativePath)).map((feature) => feature.name);
  if (exactOwners.length > 0) return exactOwners;

  return featureMap.features
    .filter((feature) => feature.paths.some((claim) => isWithin(relativePath, claim)))
    .map((feature) => feature.name)
    .sort();
}

function printUsage() {
  console.error("Usage: node scripts/gates/feature-map.mjs [--feature <name> | --path <file>]");
}

function main(args) {
  const featureMap = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "features.json"), "utf8"));
  if (args.length === 0 || (args.length === 1 && args[0] === "--check")) {
    const result = validateFeatureMap(featureMap);
    if (result.errors.length > 0) {
      for (const error of result.errors) console.error(error);
      process.exitCode = 1;
      return;
    }
    console.log(`Feature map is valid: ${result.directoryCount} source directories checked at all depths.`);
    return;
  }

  if (args.length === 2 && args[0] === "--feature") {
    const feature = featureMap.features.find((entry) => entry.name === args[1]);
    if (!feature) {
      console.error(`Unknown feature: ${args[1]}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${feature.name} (${feature.paths.length} paths)`);
    for (const featurePath of feature.paths) console.log(featurePath);
    return;
  }

  if (args.length === 2 && args[0] === "--path") {
    const absolutePath = path.resolve(repositoryRoot, args[1]);
    const relativePath = path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
    if (relativePath.startsWith("../") || relativePath === ".." || !fs.existsSync(absolutePath)) {
      console.error(`Path does not exist in this repository: ${args[1]}`);
      process.exitCode = 1;
      return;
    }
    const owners = ownersForPath(featureMap, relativePath);
    if (owners.length === 0) {
      console.error(`No feature owns ${relativePath}; add it to features.json.`);
      process.exitCode = 1;
      return;
    }
    console.log(`${relativePath}: ${owners.join(", ")}`);
    return;
  }

  printUsage();
  process.exitCode = 2;
}

if (import.meta.main) main(process.argv.slice(2));

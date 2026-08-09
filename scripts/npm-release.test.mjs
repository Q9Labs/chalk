import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { changedReleaseSources, parseArguments, parseRemoteMasterSha, publishConfirmationPhrase, publishWorkflowArguments, releasePackages, topologicalOrder, workspaceRangeMatches } from "./npm-release.mjs";

test("dry-run is the default and publish requires an explicit flag", () => {
  assert.deepEqual(parseArguments([]), { mode: "dry-run", skipInstall: false, artifactDirectory: null, help: false });
  assert.equal(parseArguments(["--publish"]).mode, "publish");
  assert.equal(parseArguments(["--", "--publish"]).mode, "publish");
  assert.throws(() => parseArguments(["--publish", "--dry-run"]), /Choose one mode/);
});

test("publish dispatch is pinned to the exact origin commit and has a clear confirmation", () => {
  const revision = "ae5da214f4ec1fd4f86db07f789be45fa914865d";
  assert.equal(publishConfirmationPhrase("4.0.0", revision.slice(0, 8)), "PUBLISH CHALK 4.0.0 FROM ae5da214");
  assert.deepEqual(publishWorkflowArguments(revision), ["workflow", "run", ".github/workflows/npm-publish.yml", "--repo", "Q9Labs/chalk", "--ref", "master", "-f", "dry_run=false", "-f", `release_sha=${revision}`]);
});

test("release options keep artifacts outside the repository", () => {
  assert.deepEqual(parseArguments(["--dry-run", "--skip-install", "--artifact-dir", "/tmp/chalk-release"]), {
    mode: "dry-run",
    skipInstall: true,
    artifactDirectory: "/tmp/chalk-release",
    help: false,
  });
  assert.throws(() => parseArguments(["--artifact-dir"]), /requires a directory path/);
});

test("only release sources make the dirty-tree preflight fail", () => {
  assert.deepEqual(changedReleaseSources(["apps/web/src/styles/landing.css", "packages/ui/src/button.tsx", "package.json", "CHANGELOG.md", ".github/workflows/npm-publish.yml", "scripts/npm-release.mjs", "scratchpad/release-notes.md"]), [
    ".github/workflows/npm-publish.yml",
    "CHANGELOG.md",
    "package.json",
    "packages/ui/src/button.tsx",
    "scripts/npm-release.mjs",
  ]);
});

test("live remote parsing requires the master ref and a full commit SHA", () => {
  const revision = "AE5DA214F4EC1FD4F86DB07F789BE45FA914865D";
  assert.equal(parseRemoteMasterSha(`${revision}\trefs/heads/master\n`), revision.toLowerCase());
  assert.throws(() => parseRemoteMasterSha("ae5da214 refs/heads/master"), /valid commit SHA/);
  assert.throws(() => parseRemoteMasterSha(`${revision}\trefs/heads/main`), /valid commit SHA/);
});

test("workspace ranges must name the expected release version", () => {
  assert.equal(workspaceRangeMatches("workspace:^4.0.0", "4.0.0"), true);
  assert.equal(workspaceRangeMatches("workspace:^4.0.0", "4.0.1"), false);
  assert.equal(workspaceRangeMatches("workspace:*", "4.0.0"), true);
  assert.equal(workspaceRangeMatches("^4.0.0", "4.0.0"), false);
});

test("packages are ordered topologically with a stable name tie-break", () => {
  const packages = [
    { name: "z-dependent", directory: "z", version: "1.0.0" },
    { name: "a-base", directory: "a", version: "1.0.0" },
    { name: "m-dependent", directory: "m", version: "1.0.0" },
  ];
  const manifests = new Map([
    ["z-dependent", { dependencies: { "a-base": "workspace:*" } }],
    ["a-base", {}],
    ["m-dependent", { dependencies: { "a-base": "workspace:*" } }],
  ]);
  assert.deepEqual(
    topologicalOrder(packages, manifests).map(({ name }) => name),
    ["a-base", "m-dependent", "z-dependent"],
  );
});

test("the release set excludes the mobile app while retaining the React Native SDK", () => {
  assert.equal(
    releasePackages.some(({ directory }) => directory === "apps/mobile"),
    false,
  );
  assert.equal(
    releasePackages.some(({ directory }) => directory === "sdks/typescript/react-native"),
    true,
  );
});

test("the generated React Native embedded tree is ignored and rebuilt from a clean destination", () => {
  const ignoreFile = readFileSync(".gitignore", "utf8");
  const syncScript = readFileSync("sdks/typescript/react-native/scripts/sync-whiteboard-assets.mjs", "utf8");
  assert.match(ignoreFile, /^sdks\/typescript\/react-native\/embedded$/m);
  assert.match(syncScript, /await rm\(destination, \{ recursive: true, force: true \}\);\s*await cp\(source, destination, \{ recursive: true \}\);/);
});

test("the publish workflow independently pins publish to live master", () => {
  const workflow = readFileSync(".github/workflows/npm-publish.yml", "utf8");
  assert.equal(workflow.includes("name: Verify publish ref"), true);
  assert.equal(workflow.includes("if: ${{ !inputs.dry_run }}"), true);
  assert.equal(workflow.includes("git ls-remote origin refs/heads/master"), true);
  assert.equal(workflow.includes('[[ \"$checked_out_sha\" != \"$live_master_sha\" ]]'), true);
});

test("the publish workflow uses options supported by pnpm publish", () => {
  const workflow = readFileSync(".github/workflows/npm-publish.yml", "utf8");
  assert.match(workflow, /pnpm "\$\{package_filters\[@\]\}" --recursive publish --access public --no-git-checks/);
  assert.match(workflow, /Skipping already published/);
});

test("the diagnostics contracts package uses the Q9Labs npm scope", () => {
  assert.equal(releasePackages[0].name, "@q9labsai/diagnostics-contracts");
});

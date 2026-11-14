import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { repositoryRoot, sourceRoots, validateFeatureMap } from "./feature-map.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chalk-feature-map-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function mapWith(...featurePaths) {
  return {
    features: [...featurePaths.map(([name, paths]) => ({ name, summary: `${name} summary.`, paths })), { name: "shared", summary: "Shared code.", paths: [] }],
  };
}

test("the checked-in feature map covers every source directory by prefix", () => {
  const featureMap = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "features.json"), "utf8"));
  const result = validateFeatureMap(featureMap);
  assert.deepEqual(result.errors, []);
  assert.ok(result.directoryCount > 0);
});

test("every mapped path must exist", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "src"));
  const result = validateFeatureMap(mapWith(["calls", ["src", "src/missing"]]), { root, roots: ["src"], excludedSubtrees: [] });
  assert.ok(result.errors.some((error) => error.includes("path does not exist: src/missing")));
});

test("a feature directory prefix covers all nested source directories", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "src", "known", "new-package"), { recursive: true });
  const result = validateFeatureMap(mapWith(["calls", ["src"]]), { root, roots: ["src"], excludedSubtrees: [] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.directoryCount, 3);
});

test("an unclaimed directory below a split source directory points to features.json", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "src", "known"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "new-package"), { recursive: true });
  const result = validateFeatureMap(mapWith(["calls", ["src/known"]]), { root, roots: ["src"], excludedSubtrees: [] });
  assert.ok(result.errors.some((error) => error === "Unclaimed source directory: src/new-package. Add this directory to features.json."));
});

test("a directory owned by more than three features fails with the shared-code hint", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "src", "shared"), { recursive: true });
  const result = validateFeatureMap(mapWith(["calls", ["src", "src/shared"]], ["media", ["src/shared"]], ["recording", ["src/shared"]], ["chat", ["src/shared"]]), { root, roots: ["src"], excludedSubtrees: [] });
  assert.ok(result.errors.some((error) => error.includes("Directory src/shared is claimed by 4 features") && error.includes("move shared code to the shared entry")));
});

test("a prefix claim covers source directories at any depth", (t) => {
  const root = fixture(t);
  const deepDirectory = path.join(root, "src", "one", "two", "three", "four");
  fs.mkdirSync(deepDirectory, { recursive: true });
  const result = validateFeatureMap(mapWith(["calls", ["src"]]), { root, roots: ["src"], excludedSubtrees: [] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.directoryCount, 5);
});

test("a file claim does not hide an unclaimed sibling file in a split directory", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "src", "split"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "split", "known.ts"), "export {};\n");
  fs.writeFileSync(path.join(root, "src", "split", "new.ts"), "export {};\n");
  const result = validateFeatureMap(mapWith(["calls", ["src/split/known.ts"]]), { root, roots: ["src"], excludedSubtrees: [] });
  assert.ok(result.errors.some((error) => error === "Unclaimed source file: src/split/new.ts. Add this file to features.json."));
});

test("ignored generated directories do not appear as unclaimed source", (t) => {
  const root = fixture(t);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  fs.writeFileSync(path.join(root, ".gitignore"), "src/generated/\n");
  fs.mkdirSync(path.join(root, "src", "live"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "generated", "bundle"), { recursive: true });
  const result = validateFeatureMap(mapWith(["calls", ["src/live"]]), { root, roots: ["src"], excludedSubtrees: [] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.directoryCount, 2);
});

test("installed dependencies are not source directories", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "src", "package"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "node_modules", "dependency"), { recursive: true });
  const result = validateFeatureMap(mapWith(["calls", ["src", "src/package"]]), { root, roots: ["src"], excludedSubtrees: [] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.directoryCount, 2);
});

test("the feature map answers for the application, SDK, package, infrastructure, workflow, documentation and tooling code", () => {
  const required = ["apps/api/internal", "apps/sync", "sdks/typescript", "packages", "apps/web", "apps/mobile", "infrastructure", ".github/workflows", ".github/actions", "docs", "features", "scripts", "tools", "contract", "tests", "perf", "release"];
  assert.deepEqual(
    required.filter((root) => !sourceRoots.includes(root)),
    [],
  );
});

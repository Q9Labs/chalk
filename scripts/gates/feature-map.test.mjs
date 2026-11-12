import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("the checked-in feature map claims every source directory", () => {
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

test("an unclaimed nested source directory points its author to features.json", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "src", "new-package"), { recursive: true });
  const result = validateFeatureMap(mapWith(["calls", ["src"]]), { root, roots: ["src"], excludedSubtrees: [] });
  assert.ok(result.errors.some((error) => error === "Unclaimed source directory: src/new-package. Add this directory to features.json."));
});

test("a directory owned by more than three features fails with the shared-code hint", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "src", "shared"), { recursive: true });
  const result = validateFeatureMap(mapWith(["calls", ["src", "src/shared"]], ["media", ["src/shared"]], ["recording", ["src/shared"]], ["chat", ["src/shared"]]), { root, roots: ["src"], excludedSubtrees: [] });
  assert.ok(result.errors.some((error) => error.includes("Directory src/shared is claimed by 4 features") && error.includes("move shared code to the shared entry")));
});

test("the source scan has no maximum directory depth", (t) => {
  const root = fixture(t);
  const deepDirectory = path.join(root, "src", "one", "two", "three", "four");
  fs.mkdirSync(deepDirectory, { recursive: true });
  const paths = ["src", "src/one", "src/one/two", "src/one/two/three", "src/one/two/three/four"];
  const result = validateFeatureMap(mapWith(["calls", paths]), { root, roots: ["src"], excludedSubtrees: [] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.directoryCount, paths.length);
});

test("installed dependencies are not source directories", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "src", "package"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "node_modules", "dependency"), { recursive: true });
  const result = validateFeatureMap(mapWith(["calls", ["src", "src/package"]]), { root, roots: ["src"], excludedSubtrees: [] });
  assert.deepEqual(result.errors, []);
  assert.equal(result.directoryCount, 2);
});

test("the required source roots cover the application, SDK, package, infrastructure, workflow, and documentation code", () => {
  assert.deepEqual(sourceRoots, ["apps/api/internal", "apps/sync", "sdks/typescript", "packages", "apps/web", "apps/mobile", "infrastructure", ".github/workflows", "docs"]);
});

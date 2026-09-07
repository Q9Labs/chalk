import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { cruise } from "dependency-cruiser";

const require = createRequire(import.meta.url);
const dependencyCruiserConfig = require("../../.dependency-cruiser.cjs");
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/package-boundaries");
const tsConfig = { fileName: resolve(fixtureRoot, "tsconfig.json") };
const ruleSet = { forbidden: dependencyCruiserConfig.forbidden ?? [] };

async function cruiseFixture(sourceFile) {
  const result = await cruise([resolve(fixtureRoot, sourceFile)], {
    doNotFollow: { path: "node_modules" },
    maxDepth: 1,
    ruleSet,
    tsConfig,
    tsPreCompilationDeps: true,
    validate: true,
  });

  if (typeof result.output === "string") {
    throw new Error("dependency-cruiser returned formatted output");
  }

  return result.output;
}

test("rejects an app's relative import into SDK source", async () => {
  const output = await cruiseFixture("apps/web/src/direct-sdk-import.ts");
  const violations = output.summary.violations.filter((violation) => violation.rule.name === "apps-use-package-entrypoints");

  assert.equal(violations.length, 1);
  assert.match(violations[0].from, /apps\/web\/src\/direct-sdk-import\.ts$/u);
  assert.match(violations[0].to, /sdks\/typescript\/react\/src\/test-support\/index\.ts$/u);
});

test("allows the explicit preview package entrypoint alias", async () => {
  const output = await cruiseFixture("apps/web/src/package-entrypoint-import.ts");
  const violations = output.summary.violations.filter((violation) => violation.rule.name === "apps-use-package-entrypoints");
  const sourceModule = output.modules.find((module) => module.source.endsWith("apps/web/src/package-entrypoint-import.ts"));
  const previewDependency = sourceModule?.dependencies.find((dependency) => dependency.module === "@q9labsai/chalk-react/preview");

  assert.equal(violations.length, 0);
  assert.ok(previewDependency, "expected the preview entrypoint alias to resolve");
  assert.ok(previewDependency.dependencyTypes.includes("aliased"));
  assert.match(previewDependency.resolved, /sdks\/typescript\/react\/src\/test-support\/index\.ts$/u);
});

test("rejects private source imports between packages, SDKs, and apps", async () => {
  const packageOutput = await cruiseFixture("packages/alpha/src/direct-workspace-imports.ts");
  const sdkOutput = await cruiseFixture("sdks/typescript/alpha/src/direct-workspace-imports.ts");

  assert.deepEqual(packageOutput.summary.violations.map((violation) => violation.rule.name).toSorted(), ["no-cross-package-src-imports", "packages-use-sdk-entrypoints", "workspace-packages-do-not-import-apps"]);
  assert.deepEqual(sdkOutput.summary.violations.map((violation) => violation.rule.name).toSorted(), ["sdks-use-package-entrypoints", "sdks-use-sdk-entrypoints", "workspace-packages-do-not-import-apps"]);
});

test("allows a named package import across package workspaces", async () => {
  const output = await cruiseFixture("packages/alpha/src/package-entrypoint-import.ts");
  const sourceModule = output.modules.find((module) => module.source.endsWith("packages/alpha/src/package-entrypoint-import.ts"));
  const packageDependency = sourceModule?.dependencies.find((dependency) => dependency.module === "@q9labsai/chalk-assets");

  assert.equal(output.summary.violations.length, 0);
  assert.ok(packageDependency, "expected the package entrypoint alias to resolve");
  assert.ok(packageDependency.dependencyTypes.includes("aliased-workspace"));
  assert.match(packageDependency.resolved, /packages\/assets\/src\/index\.ts$/u);
});

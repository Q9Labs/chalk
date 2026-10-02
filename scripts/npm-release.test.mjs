import assert from "node:assert/strict";
import test from "node:test";

import { bumpWorkspaceRange, chalkReleaseVersion, loadReleaseManifests, parseArguments, planVersionBump, releasePackages } from "./npm-release.mjs";

const synchronizedPackages = ["@q9labsai/chalk-assets", "@q9labsai/facehash", "@q9labsai/chalk-ui", "@q9labsai/chalk-whiteboard", "@q9labsai/chalk-client", "@q9labsai/chalk-react", "@q9labsai/chalk-react-native"];

test("the release set contains seven synchronized Chalk packages and an independent diagnostics package", () => {
  assert.match(chalkReleaseVersion, /^\d+\.\d+\.\d+/);
  assert.deepEqual(
    releasePackages.filter(({ name }) => name !== "@q9labsai/diagnostics-contracts").map(({ name }) => name),
    synchronizedPackages,
  );
  assert.equal(releasePackages.find(({ name }) => name === "@q9labsai/diagnostics-contracts")?.version, "0.1.1");
  assert.equal(releasePackages.filter(({ version }) => version === chalkReleaseVersion).length, synchronizedPackages.length);
});

test("release metadata matches every declared package manifest", () => {
  const manifests = loadReleaseManifests();
  for (const releasePackage of releasePackages) {
    assert.equal(manifests.get(releasePackage.name)?.version, releasePackage.version, releasePackage.name);
  }
});

test("bump rewrites explicit workspace ranges and leaves bare ranges alone", () => {
  assert.equal(bumpWorkspaceRange("workspace:^4.1.16", "4.1.16", "4.2.0"), "workspace:^4.2.0");
  assert.equal(bumpWorkspaceRange("workspace:*", "4.1.16", "4.2.0"), "workspace:*");
  assert.equal(bumpWorkspaceRange("workspace:^0.1.1", "4.1.16", "4.2.0"), "workspace:^0.1.1");
});

test("bump plan updates release versions, every consumer range, and the client release id", () => {
  const clientSource = "sdks/typescript/client/src/space-client/core.ts";
  const files = new Map([
    ["packages/ui/package.json", JSON.stringify({ name: "@q9labsai/chalk-ui", version: "4.1.16" }, null, 2)],
    ["apps/recording-renderer/package.json", JSON.stringify({ name: "recording-renderer", version: "0.0.0", dependencies: { "@q9labsai/chalk-react": "workspace:^4.1.16" } }, null, 2)],
    ["apps/unrelated/package.json", JSON.stringify({ name: "unrelated", version: "4.1.16" }, null, 2)],
    [clientSource, 'release: { id: "chalk-client@4.1.16" }'],
  ]);
  const changes = planVersionBump(files, "4.1.16", "4.2.0");
  assert.deepEqual([...changes.keys()].sort(), ["apps/recording-renderer/package.json", "packages/ui/package.json", clientSource]);
  assert.equal(JSON.parse(changes.get("packages/ui/package.json")).version, "4.2.0");
  assert.equal(JSON.parse(changes.get("apps/recording-renderer/package.json")).dependencies["@q9labsai/chalk-react"], "workspace:^4.2.0");
  assert.match(changes.get(clientSource), /chalk-client@4\.2\.0/);
});

test("bump rejects a non-version and the current version", () => {
  assert.throws(() => planVersionBump(new Map(), "4.1.16", "next"), /requires a version/);
  assert.throws(() => planVersionBump(new Map(), "4.1.16", "4.1.16"), /already/);
});

test("--bump parses in both forms", () => {
  assert.equal(parseArguments(["--bump", "4.2.0"]).bump, "4.2.0");
  assert.equal(parseArguments(["--bump=4.2.0", "--dry-run"]).dryRun, true);
  assert.throws(() => parseArguments(["--bump"]), /requires a version/);
});

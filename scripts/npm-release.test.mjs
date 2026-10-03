import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { bumpWorkspaceRange, chalkReleaseVersion, deriveReleasePackages, loadReleaseManifests, parseArguments, planVersionBump, releasePackages, topologicalOrder } from "./npm-release.mjs";

const synchronizedPackages = ["@q9labsai/chalk-assets", "@q9labsai/facehash", "@q9labsai/chalk-ui", "@q9labsai/chalk-whiteboard", "@q9labsai/chalk-client", "@q9labsai/chalk-react", "@q9labsai/chalk-react-native"];

test("the release set contains seven synchronized Chalk packages and independent runtime contract packages", () => {
  assert.match(chalkReleaseVersion, /^\d+\.\d+\.\d+/);
  assert.deepEqual(
    releasePackages.filter(({ version }) => version === chalkReleaseVersion).map(({ name }) => name),
    synchronizedPackages,
  );
  assert.equal(releasePackages.find(({ name }) => name === "@q9labsai/diagnostics-contracts")?.version, "0.1.1");
  assert.equal(releasePackages.filter(({ version }) => version === chalkReleaseVersion).length, synchronizedPackages.length);
});

test("the React runtime contract is validated and ordered before React", () => {
  const manifests = loadReleaseManifests();
  assert.equal(releasePackages.find(({ name }) => name === "@q9labsai/recording-presentation")?.version, "0.1.0");
  const order = topologicalOrder(releasePackages, manifests).map(({ name }) => name);
  assert.ok(order.indexOf("@q9labsai/recording-presentation") < order.indexOf("@q9labsai/chalk-react"));
});

test("new public runtime dependencies enter the set using their manifest versions", () => {
  const workspaces = [
    { directory: "sdk", manifest: { name: "sdk", version: "2.0.0", dependencies: { contract: "workspace:*" } } },
    { directory: "contract", manifest: { name: "contract", version: "0.2.0", optionalDependencies: { helper: "workspace:*" } } },
    { directory: "helper", manifest: { name: "helper", version: "0.3.0" } },
    { directory: "app", manifest: { name: "app", private: true } },
  ];
  assert.deepEqual(
    deriveReleasePackages(workspaces).map(({ name, version }) => [name, version]),
    [
      ["sdk", "2.0.0"],
      ["contract", "0.2.0"],
      ["helper", "0.3.0"],
    ],
  );
  workspaces[2].manifest.private = true;
  assert.throws(() => deriveReleasePackages(workspaces), /contract has a runtime dependency on private workspace helper/);
});

test("release metadata matches every declared package manifest", () => {
  const manifests = loadReleaseManifests();
  for (const releasePackage of releasePackages) {
    assert.equal(manifests.get(releasePackage.name)?.version, releasePackage.version, releasePackage.name);
  }
});

test("the npm workflow publishes exactly the tool's release set", () => {
  const workflow = readFileSync(new URL("../.github/workflows/npm-publish.yml", import.meta.url), "utf8");
  const publishStep = workflow.split("      - name: Publish packages")[1];
  const selection = publishStep.match(/done < <\(\n\s+(.+)\n\s+\)/)?.[1];
  assert.ok(selection, "publish step must select release packages");
  const selected = execFileSync("bash", ["-c", selection], { cwd: new URL("..", import.meta.url), encoding: "utf8" })
    .trim()
    .split("\n");
  assert.deepEqual(
    selected,
    releasePackages.map(({ name, version }) => `${name}\t${version}`),
  );
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
    ["packages/recording-presentation/package.json", JSON.stringify({ name: "@q9labsai/recording-presentation", version: "0.1.0" }, null, 2)],
    ["packages/diagnostics-contracts/package.json", JSON.stringify({ name: "@q9labsai/diagnostics-contracts", version: "0.1.1" }, null, 2)],
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

test("bump leaves independently versioned runtime contracts and their consumer ranges unchanged", () => {
  const files = new Map([
    ["packages/ui/package.json", JSON.stringify({ name: "@q9labsai/chalk-ui", version: "0.1.0" }, null, 2)],
    ["packages/recording-presentation/package.json", JSON.stringify({ name: "@q9labsai/recording-presentation", version: "0.1.0" }, null, 2)],
    ["apps/consumer/package.json", JSON.stringify({ name: "consumer", dependencies: { "@q9labsai/chalk-ui": "workspace:^0.1.0", "@q9labsai/recording-presentation": "workspace:^0.1.0" } }, null, 2)],
  ]);
  const changes = planVersionBump(files, "0.1.0", "0.2.0");
  assert.equal(changes.has("packages/recording-presentation/package.json"), false);
  assert.equal(JSON.parse(changes.get("packages/ui/package.json")).version, "0.2.0");
  const consumer = JSON.parse(changes.get("apps/consumer/package.json"));
  assert.equal(consumer.dependencies["@q9labsai/chalk-ui"], "workspace:^0.2.0");
  assert.equal(consumer.dependencies["@q9labsai/recording-presentation"], "workspace:^0.1.0");
});

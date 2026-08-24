import assert from "node:assert/strict";
import test from "node:test";

import { chalkReleaseVersion, loadReleaseManifests, releasePackages } from "./npm-release.mjs";

const synchronizedPackages = ["@q9labsai/chalk-assets", "@q9labsai/facehash", "@q9labsai/chalk-ui", "@q9labsai/chalk-whiteboard", "@q9labsai/chalk-client", "@q9labsai/chalk-react", "@q9labsai/chalk-react-native"];

test("the release set contains seven synchronized Chalk packages and an independent diagnostics package", () => {
  assert.equal(chalkReleaseVersion, "4.1.14");
  assert.deepEqual(
    releasePackages.filter(({ name }) => name !== "@q9labsai/diagnostics-contracts").map(({ name }) => name),
    synchronizedPackages,
  );
  assert.equal(releasePackages.find(({ name }) => name === "@q9labsai/diagnostics-contracts")?.version, "0.1.1");
  assert.equal(releasePackages.filter(({ version }) => version === "4.1.14").length, synchronizedPackages.length);
});

test("release metadata matches every declared package manifest", () => {
  const manifests = loadReleaseManifests();
  for (const releasePackage of releasePackages) {
    assert.equal(manifests.get(releasePackage.name)?.version, releasePackage.version, releasePackage.name);
  }
});

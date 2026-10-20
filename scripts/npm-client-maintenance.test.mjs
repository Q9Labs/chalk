import assert from "node:assert/strict";
import { test } from "node:test";
import { maintenanceTag } from "./npm-client-maintenance.mjs";

const sha = "a".repeat(40);
const release = {
  ref: "refs/heads/release/client-4.1",
  sha,
  checkedOutSha: sha,
  liveSha: sha,
  manifest: { name: "@q9labsai/chalk-client", version: "4.1.18" },
  expectedVersion: "4.1.18",
  versions: ["4.1.9", "4.1.17"],
};

test("4.1.18 takes latest only when no newer line exists", () => {
  assert.equal(maintenanceTag(release), "latest");
  for (const newer of ["5.0.0", "5.0.0-beta.1", "4.2.0", "10.0.0"]) {
    assert.equal(maintenanceTag({ ...release, versions: [...release.versions, newer] }), "release-4.1");
  }
});

test("only the live release branch head can publish", () => {
  for (const ref of ["refs/heads/master", "refs/tags/release/client-4.1", "refs/heads/release/client-4.1.18", "refs/heads/release/client-04.1"]) {
    assert.throws(() => maintenanceTag({ ...release, ref }), /branch/);
  }
  for (const change of [{ sha: "b".repeat(40) }, { checkedOutSha: "b".repeat(40) }, { liveSha: "" }, { liveSha: "b".repeat(40) }]) {
    assert.throws(() => maintenanceTag({ ...release, ...change }), /live release branch head/);
  }
});

test("the explicit stable client version must match the branch line", () => {
  for (const version of ["4.2.18", "5.0.0", "4.1.18-beta.1", "04.1.18"]) {
    assert.throws(() => maintenanceTag({ ...release, manifest: { ...release.manifest, version }, expectedVersion: version }));
  }
  for (const expectedVersion of [undefined, "", "4.1.19"]) {
    assert.throws(() => maintenanceTag({ ...release, expectedVersion }), /explicit/);
  }
  assert.throws(() => maintenanceTag({ ...release, manifest: { ...release.manifest, name: "@q9labsai/chalk-react" } }), /manifest/);
});

test("existing and older patches fail closed, with numeric version ordering", () => {
  for (const published of ["4.1.18", "4.1.19", "4.1.100"]) {
    assert.throws(() => maintenanceTag({ ...release, versions: [...release.versions, published] }), /exceed/);
  }
  assert.equal(maintenanceTag({ ...release, versions: ["4.1.9", "4.1.18-beta.1", "3.9.99"] }), "latest");
});

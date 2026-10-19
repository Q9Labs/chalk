import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = fileURLToPath(new URL("./", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function artifact(t) {
  const root = mkdtempSync(join(tmpdir(), "chalk-dispatcher-artifact-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const staging = join(root, "staging");
  mkdirSync(staging);
  writeFileSync(join(staging, "index.js"), "export const handler = async () => {};");
  const temporary = join(root, "fixture.zip");
  execFileSync("zip", ["-q", temporary, "index.js"], { cwd: staging });
  const bytes = readFileSync(temporary);
  const sha256 = hash(bytes);
  const name = `transcription-dispatcher-contract-check-${sha256}.zip`;
  const zip = join(root, name);
  writeFileSync(zip, bytes);
  writeFileSync(`${zip}.sha256`, `${sha256}  ${name}\n`);
  execFileSync(process.execPath, [join(scripts, "emit-manifest.mjs"), "--staging", staging, "--zip", zip, "--sha256", sha256, "--release-id", "contract-check", "--source-revision", "a".repeat(40), "--source-state", "clean", "--source-date-epoch", "0", "--output-dir", root]);
  const manifest = zip.replace(/\.zip$/, ".manifest.json");
  return { zip, manifest, sha256, read: () => JSON.parse(readFileSync(manifest, "utf8")) };
}

function verify(zip, environment = {}) {
  return spawnSync("bash", [join(scripts, "verify-artifact.sh"), zip], {
    encoding: "utf8",
    env: { ...process.env, ALLOW_DIRTY_SOURCE: "0", ...environment },
  });
}

test("emitted manifest and sidecars describe a verifiable ZIP", (t) => {
  const value = artifact(t);
  const manifest = value.read();
  assert.equal(manifest.artifact.sha256, value.sha256);
  assert.equal(manifest.files[0].path, "index.js");
  for (const sidecar of [manifest.sbom, manifest.provenance]) {
    assert.equal(hash(readFileSync(join(dirname(value.zip), sidecar.filename))), sidecar.sha256);
  }
  const result = verify(value.zip);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified immutable transcription dispatcher artifact/);
});

test("artifact verification rejects corrupted bytes and mismatched manifests", (t) => {
  const value = artifact(t);
  const manifest = value.read();
  writeFileSync(value.manifest, JSON.stringify({ ...manifest, artifact: { ...manifest.artifact, sha256: "0".repeat(64) } }));
  let result = verify(value.zip);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release manifest does not describe this exact artifact/);
  writeFileSync(value.manifest, JSON.stringify(manifest));
  writeFileSync(value.zip, "corrupt ZIP");
  result = verify(value.zip);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifact digest mismatch/);
});

test("dirty local provenance needs the explicit local-only override and a source digest", (t) => {
  const value = artifact(t);
  const manifest = { ...value.read(), source_state: "dirty-local-proof", source_tree_digest: "b".repeat(64) };
  writeFileSync(value.manifest, JSON.stringify(manifest));
  assert.match(verify(value.zip).stderr, /dirty-local-proof provenance is rejected/);
  assert.equal(verify(value.zip, { ALLOW_DIRTY_SOURCE: "1" }).status, 0);
  delete manifest.source_tree_digest;
  writeFileSync(value.manifest, JSON.stringify(manifest));
  assert.match(verify(value.zip, { ALLOW_DIRTY_SOURCE: "1" }).stderr, /no deterministic source digest/);
});

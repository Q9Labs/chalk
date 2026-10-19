import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const managedRoot = new URL("../../infrastructure/managed-episode/", import.meta.url);
const release = "runtime-environment-test";
const source = "a".repeat(40);
const excluded = "cloudflare-tunnel-token,provider-bridge-api-server-ca,provider-bridge-api-server-cert,provider-bridge-api-server-key,provider-bridge-sync-client-ca,provider-bridge-sync-client-cert,provider-bridge-sync-client-key";

async function runtimeFixture(directory, environment = "production") {
  for (const component of ["api", "sync"]) {
    const template = await readFile(new URL(`env/${component}${environment === "nightly" ? ".nightly" : ""}.env.example`, managedRoot), "utf8");
    const values = template
      .replaceAll(/^#.*$/gm, "")
      .replaceAll("__RELEASE_ID__", release)
      .replaceAll("__SOURCE_COMMIT__", source)
      .replaceAll("__SYNC_INSTANCE_ID__", "sync-test")
      .replaceAll("__SYNC_GENERATION__", "1")
      .replaceAll(/__SECRET_[A-Z_]*URL_WITH_SSLMODE_VERIFY_FULL__/g, "postgres://fixture.invalid/db?sslmode=verify-full")
      .replaceAll(/__SECRET_([A-Z0-9_]+)__/g, "test-only-$1")
      .replaceAll("__SECRET__", "test-only-value");
    await writeFile(join(directory, `${component}.env`), values, { mode: 0o600 });
  }
  await mkdir(join(directory, "secrets"), { recursive: true });
  const proof = {
    schema_version: 1,
    provider: "planetscale-postgresql",
    postgresql_major: 18,
    connection_mode: "direct",
    role_query_supported: true,
    pg_stat_replication_visible: true,
    synchronous_standby_names_configured: true,
    synchronous_standbys: 1,
    require_synchronous_standby: false,
    writable_primary: true,
    fsync: "on",
    full_page_writes: "on",
    data_checksums: "on",
    synchronous_commit: "on",
    evidence_id: "test-only",
    verified_at: "2026-10-17T00:00:00Z",
  };
  await writeFile(join(directory, "proof.json"), JSON.stringify(proof), { mode: 0o600 });
  const images = Object.fromEntries(["api", "sync", "redis", "cloudflared"].map((component) => [component, `example.invalid/${component}@sha256:${"b".repeat(64)}`]));
  const manifest = {
    schema_version: 1,
    release_id: release,
    source_revision: source,
    source_tree_state: "clean",
    architectures: ["linux/arm64"],
    images,
    runtime_artifacts: {},
    database_compatibility: { engine: "postgresql", major: 18, minimum_migration: 20260819130000, maximum_migration: null },
    protocol_compatibility: { sync: 1 },
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
}

test("the real runtime validator binds telemetry to the selected environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-runtime-environment-"));
  try {
    await runtimeFixture(directory);
    const args = [new URL("scripts/validate-runtime", managedRoot).pathname, "--env-root", directory, "--secret-root", join(directory, "secrets"), "--manifest", join(directory, "manifest.json"), "--sync-proof", join(directory, "proof.json"), "--excluded-secrets", excluded];
    const production = spawnSync("bash", args, { encoding: "utf8" });
    assert.equal(production.status, 0, production.stderr);
    await runtimeFixture(directory, "nightly");
    // Recording controls are covered separately; these fixtures exercise API/Sync.
    const apiPath = join(directory, "api.env");
    await writeFile(apiPath, (await readFile(apiPath, "utf8")).replace("CHALK_RECORDING_ENABLED=true", "CHALK_RECORDING_ENABLED=false").replace("CHALK_TRANSCRIPTION_ENABLED=true", "CHALK_TRANSCRIPTION_ENABLED=false"));
    const syncPath = join(directory, "sync.env");
    const nightly = spawnSync("bash", args.concat("--environment", "nightly"), { encoding: "utf8" });
    assert.equal(nightly.status, 0, nightly.stderr);
    await writeFile(syncPath, (await readFile(syncPath, "utf8")).replace("https://nightly-api.chalkmeet.com", "https://api.chalkmeet.com"));
    const mismatch = spawnSync("bash", args.concat("--environment", "nightly"), { encoding: "utf8" });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /nightly token issuer|nightly Sync API/);
    assert.notEqual(spawnSync("bash", args, { encoding: "utf8" }).status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the nightly examples validate with recording, transcription and freshly issued TLS inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-nightly-full-runtime-"));
  try {
    await runtimeFixture(directory, "nightly");
    const manifestPath = join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.images.recorder_control = manifest.images.api;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await issueTestCertificates(directory);
    await writeSecretInputs(directory);
    await writeRecorderInputs(directory);
    const args = [new URL("scripts/validate-runtime", managedRoot).pathname, "--env-root", directory, "--secret-root", join(directory, "secrets"), "--manifest", manifestPath, "--sync-proof", join(directory, "proof.json"), "--excluded-secrets", "cloudflare-tunnel-token", "--environment", "nightly"];
    const validated = spawnSync("bash", args, { encoding: "utf8" });
    assert.equal(validated.status, 0, validated.stderr);
    const apiPath = join(directory, "api.env");
    await writeFile(apiPath, (await readFile(apiPath, "utf8")).replace(/^CHALK_RECORDING_KMS_KEY_ID=.*\n/m, ""));
    const missingKey = spawnSync("bash", args, { encoding: "utf8" });
    assert.notEqual(missingKey.status, 0);
    assert.match(missingKey.stderr, /CHALK_RECORDING_KMS_KEY_ID/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function issueTestCertificates(directory) {
  function command(args) {
    const result = spawnSync("openssl", args, { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  command(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2", "-subj", "/CN=nightly-test-ca", "-keyout", "ca.key", "-out", "ca.crt"]);
  command(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", "/CN=nightly-recording-control.chalkmeet.com", "-keyout", "leaf.key", "-out", "leaf.csr"]);
  await writeFile(join(directory, "extensions"), "basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:nightly-recording-control.chalkmeet.com,DNS:chalk-api\n");
  command(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-extfile", "extensions", "-out", "leaf.crt"]);
}

async function writeSecretInputs(directory) {
  const inventory = JSON.parse(await readFile(new URL("contracts/runtime-inputs.json", managedRoot), "utf8"));
  for (const input of inventory.inputs.filter((input) => input.kind === "secret-file" && input.id !== "cloudflare-tunnel-token")) {
    const relative = input.destination.replace("secret-inputs/", "");
    const target = join(directory, "secrets", relative);
    await mkdir(dirname(target), { recursive: true });
    const data = await secretFixture(input, directory);
    await writeFile(target, data, { mode: 0o600 });
  }
}

async function writeRecorderInputs(directory) {
  for (const role of ["capture", "render", "issuer"]) {
    let values = (await readFile(new URL(`../nightly/env/recorder-${role}.env.example`, managedRoot), "utf8")).replaceAll(/__[A-Z0-9_]+__/g, "test-only-value");
    if (role !== "issuer") values += `\nCHALK_RECORDER_FLEET_ROLE=${role}\nCHALK_RECORDER_FLEET_ENVIRONMENT=nightly\nCHALK_RECORDER_FLEET_MAX_NODES=1\nCHALK_RECORDER_FLEET_SLOTS_PER_NODE=1\n`;
    else values += "\nCHALK_RECORDER_FLEET_ISSUER_ENVIRONMENT=nightly\n";
    await writeFile(join(directory, `recorder-${role}.env`), values, { mode: 0o600 });
  }
}

async function secretFixture(input, directory) {
  if (input.id.endsWith("token")) return "test-only-token";
  const basename = certificateBasename(input.id);
  const extension = input.id.endsWith("key") ? "key" : "crt";
  return readFile(join(directory, `${basename}.${extension}`));
}

function certificateBasename(id) {
  return id.includes("ca") && !id.includes("capture") ? "ca" : "leaf";
}

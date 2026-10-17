import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const managedRoot = new URL("../../infrastructure/managed-episode/", import.meta.url);
const release = "runtime-environment-test";
const source = "a".repeat(40);
const excluded = "cloudflare-tunnel-token,provider-bridge-api-server-ca,provider-bridge-api-server-cert,provider-bridge-api-server-key,provider-bridge-sync-client-ca,provider-bridge-sync-client-cert,provider-bridge-sync-client-key";

async function runtimeFixture(directory) {
  for (const component of ["api", "sync"]) {
    const template = await readFile(new URL(`env/${component}.env.example`, managedRoot), "utf8");
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
  await mkdir(join(directory, "secrets"));
  const proof = {
    schema_version: 1,
    provider: "planetscale-postgresql",
    postgresql_major: 18,
    connection_mode: "direct",
    role_query_supported: true,
    pg_stat_replication_visible: true,
    synchronous_standby_names_configured: true,
    synchronous_standbys: 1,
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
    const syncPath = join(directory, "sync.env");
    await writeFile(syncPath, (await readFile(syncPath, "utf8")).replace("deployment.environment.name=production", "deployment.environment.name=preview-2"));
    const mismatch = spawnSync("bash", args, { encoding: "utf8" });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /OTEL_RESOURCE_ATTRIBUTES/);
    const preview = spawnSync("bash", args.concat("--environment", "preview-2"), { encoding: "utf8" });
    assert.equal(preview.status, 0, preview.stderr);
    assert.notEqual(spawnSync("bash", args.concat("--environment", "production"), { encoding: "utf8" }).status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

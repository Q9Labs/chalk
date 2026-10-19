import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../../", import.meta.url).pathname;
const managed = "infrastructure/managed-episode";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}

async function files(directory, prefix = "") {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...(await files(directory, relative)));
    else result.push(relative);
  }
  return result.sort();
}

test("production rendering matches master byte-for-byte; nightly caps and names are isolated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chalk-nightly-render-"));
  try {
    const baseline = join(directory, "master");
    await mkdir(baseline);
    // Use the PR base tree, not a second hand-maintained renderer or golden copy.
    const archive = run("git", ["archive", process.env.CHALK_ENV_BASE_REF ?? "origin/master", managed], { encoding: null, maxBuffer: 8 * 1024 * 1024 });
    run("tar", ["-xf", "-", "-C", baseline], { input: archive });
    const images = Object.fromEntries(["api", "sync", "redis", "cloudflared", "recorder_control"].map((name) => [name, `example.invalid/${name}@sha256:${"a".repeat(64)}`]));
    const manifest = join(directory, "release.json");
    await writeFile(manifest, JSON.stringify({ images, database_compatibility: { minimum_migration: 20260819130000 } }));
    await assertProductionRendering(directory, baseline, manifest, images);
    await assertNightlyConfig(directory, manifest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function assertProductionRendering(directory, baseline, manifest, images) {
  for (const recording of [false, true]) {
    if (!recording) delete images.recorder_control;
    else images.recorder_control = images.api;
    await writeFile(manifest, JSON.stringify({ images, database_compatibility: { minimum_migration: 20260819130000 } }));
    const before = join(directory, `before-${recording}`);
    const after = join(directory, `after-${recording}`);
    run("bash", [join(baseline, managed, "scripts/render-runtime"), manifest, before]);
    for (const environment of [[], ["production"]]) {
      const rendered = `${after}-${environment.length}`;
      run("bash", [join(root, managed, "scripts/render-runtime"), manifest, rendered, ...environment]);
      await assertSameRenderedFiles(before, rendered);
    }
  }
}

async function assertSameRenderedFiles(before, rendered) {
  assert.deepEqual(await files(rendered), await files(before));
  for (const file of await files(before)) assert.deepEqual(await readFile(join(rendered, file)), await readFile(join(before, file)), file);
}

async function assertNightlyConfig(directory, manifest) {
  const nightly = join(directory, "nightly");
  run("bash", [join(root, managed, "scripts/render-runtime"), manifest, nightly, "nightly"]);
  await assertNightlyMemoryCaps(nightly);
  const ingress = JSON.parse(await readFile(join(root, managed, "cloudflare/ingress.nightly.json"), "utf8"));
  assert.equal(ingress.environment, "nightly");
  assert.deepEqual(ingress.routes.map((route) => route.hostname).filter(Boolean), ["nightly-api.chalkmeet.com", "nightly-sync.chalkmeet.com"]);
  for (const component of ["api", "sync"]) {
    const example = await readFile(join(root, managed, `env/${component}.nightly.env.example`), "utf8");
    assert.doesNotMatch(example, /=production|https:\/\/(?:api|sync)\.chalkmeet\.com/);
    assert.match(example, /^CHALK_SYNC_TOKEN_AUDIENCE=chalk-sync$/m);
    assert.match(example, /CHALK_API_ENV=nightly/);
  }
}

async function assertNightlyMemoryCaps(nightly) {
  const budget = Object.fromEntries(
    (await readFile(join(root, "infrastructure/nightly/README.md"), "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) =>
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      ),
  );
  const labels = {
    "chalk-api.container": "API",
    "chalk-sync.container": "Sync",
    "chalk-redis.container": "Redis",
    "chalk-cloudflared.container": "Tunnel",
    "chalk-recorder-capture.container": "Capture controller",
    "chalk-recorder-render.container": "Render controller",
    "chalk-recorder-issuer.container": "Issuer",
    "chalk-api-migrate.container": "One-shot migrator",
  };
  let totalMiB = 0;
  for (const file of await files(join(nightly, "quadlet"))) {
    const text = await readFile(join(nightly, "quadlet", file), "utf8");
    assert.doesNotMatch(text, /production|https:\/\/(?:api|sync)\.chalkmeet\.com/);
    const cap = text.match(/--memory=(\d+)m/);
    if (file.endsWith(".container")) assert.ok(cap, `${file} has no nightly memory cap`);
    if (cap) {
      assert.equal(Number(budget[labels[file]]), Number(cap[1]), `${file} differs from its runbook budget`);
      totalMiB += Number(cap[1]);
    }
  }
  assert.equal(totalMiB, 880);
  assert.equal(Number(budget["Total including migrator"]), totalMiB);
  assert.ok(2048 - totalMiB - 640 >= 512);
}

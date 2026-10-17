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
    for (const recording of [false, true]) {
      if (!recording) delete images.recorder_control;
      else images.recorder_control = images.api;
      await writeFile(manifest, JSON.stringify({ images, database_compatibility: { minimum_migration: 20260819130000 } }));
      const before = join(directory, `before-${recording}`);
      const after = join(directory, `after-${recording}`);
      run("bash", [join(baseline, managed, "scripts/render-runtime"), manifest, before]);
      run("bash", [join(root, managed, "scripts/render-runtime"), manifest, after, "production"]);
      assert.deepEqual(await files(after), await files(before));
      for (const file of await files(before)) assert.deepEqual(await readFile(join(after, file)), await readFile(join(before, file)), file);
    }
    await assertNightlyConfig(directory, manifest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function assertNightlyConfig(directory, manifest) {
  const nightly = join(directory, "nightly");
  run("bash", [join(root, managed, "scripts/render-runtime"), manifest, nightly, "nightly"]);
  let totalMiB = 0;
  for (const file of await files(join(nightly, "quadlet"))) {
    const text = await readFile(join(nightly, "quadlet", file), "utf8");
    assert.doesNotMatch(text, /production|https:\/\/(?:api|sync)\.chalkmeet\.com/);
    const cap = text.match(/--memory=(\d+)m/);
    if (file.endsWith(".container")) assert.ok(cap, `${file} has no nightly memory cap`);
    if (cap) totalMiB += Number(cap[1]);
  }
  assert.equal(totalMiB, 880);
  assert.ok(2048 - totalMiB - 640 >= 512);
  const ingress = JSON.parse(await readFile(join(root, managed, "cloudflare/ingress.nightly.json"), "utf8"));
  assert.equal(ingress.environment, "nightly");
  assert.deepEqual(ingress.routes.map((route) => route.hostname).filter(Boolean), ["nightly-api.chalkmeet.com", "nightly-sync.chalkmeet.com"]);
  for (const component of ["api", "sync"]) {
    const example = await readFile(join(root, managed, `env/${component}.nightly.env.example`), "utf8");
    assert.doesNotMatch(example, /=production|https:\/\/(?:api|sync)\.chalkmeet\.com|=chalk-sync\n/);
    assert.match(example, /CHALK_API_ENV=nightly/);
  }
}

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { loadavg, cpus } from "node:os";
import { resolveDevConfig } from "./config.mjs";
import { readManifest } from "./ownership.mjs";
import { containerNames } from "./containers.mjs";
import { runChecked } from "./chalk-resources.mjs";

const config = resolveDevConfig();
const label = process.argv[2] || "sample";
assert.match(label, /^[a-z0-9-]+$/i);
const source = `${config.root}/apps/sync/lib/chalk_sync/application.ex`;
const original = await readFile(source, "utf8");
const samples = [];
let edited = false;
async function ready(changedPid, timeline, start) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const manifest = await readManifest(config);
    assert.equal(manifest?.checkout, config.root, "measure only this checkout's runtime");
    assert.ok(!["failed", "reload-failed"].includes(manifest.state), JSON.stringify(manifest.failure));
    if (manifest.state === "reloading" && timeline && timeline.detectedMs === undefined) timeline.detectedMs = performance.now() - start;
    const sync = Object.fromEntries(manifest.services).sync;
    if (manifest.state === "ready" && (!changedPid || sync.pid !== changedPid)) return sync.pid;
    await delay(25);
  }
  throw new Error("Sync reload did not reach ready");
}

try {
  for (let index = 0; index < 4; index++) {
    const pid = await ready();
    const webPid = Object.fromEntries((await readManifest(config)).services).web.pid;
    const marker = `chalk_reload_${randomBytes(6).toString("hex")}`;
    const sample = { sample: index, load: loadavg()[0], cores: cpus().length };
    const start = performance.now();
    edited = true;
    await writeFile(source, original.replace("defmodule ChalkSync.Application do", `defmodule ChalkSync.Application do\n  def reload_measurement_marker, do: :${marker}`));
    sample.pid = await ready(pid, sample, start);
    assert.equal((await fetch(`${config.urls.sync}/readyz`)).status, 200);
    sample.reloadMs = performance.now() - start;
    sample.webRestarted = Object.fromEntries((await readManifest(config)).services).web.pid !== webPid;
    const { stdout } = await runChecked("docker", ["exec", containerNames(config).sync, "cat", "_build/prod/lib/chalk_sync/ebin/Elixir.ChalkSync.Application.beam"]);
    assert.ok(stdout.includes(marker), "the edited module was compiled inside the timed reload");
    console.log(JSON.stringify({ ...sample, warmup: index === 0 }));
    if (index) samples.push(sample);
  }
} finally {
  if (edited) {
    const manifest = await readManifest(config).catch(() => undefined);
    await writeFile(source, original);
    if (manifest?.state === "ready") await ready(Object.fromEntries(manifest.services).sync.pid);
  }
}
await mkdir(`${config.root}/.verify/sync-reload`, { recursive: true });
await writeFile(`${config.root}/.verify/sync-reload/${label}.json`, `${JSON.stringify(samples, null, 2)}\n`);

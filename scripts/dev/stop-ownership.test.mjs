import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stopCommand } from "./commands.mjs";
import { FailureKind } from "./model.mjs";

async function fixture(owner) {
  const root = await mkdtemp(join(tmpdir(), "chalk-dev-stop-"));
  const config = { root: "/checkout/a", ownerPath: join(root, "owner.json"), manifestPath: join(root, "manifest.json"), lockPath: join(root, "lock"), timeouts: { stopGraceMs: 10, stopTimeoutMs: 100 } };
  await mkdir(config.lockPath);
  await writeFile(join(config.lockPath, "lease.json"), JSON.stringify({ supervisorPid: owner.supervisorPid }));
  await writeFile(config.ownerPath, JSON.stringify({ runtimeId: "r1", checkout: "/checkout/a", manifestPath: config.manifestPath, ...owner }));
  return { config, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("stop treats a dead supervisor as released and clears the owner and lock", async (t) => {
  const { config, cleanup } = await fixture({ supervisorPid: 999999 });
  t.after(cleanup);
  const lines = [];
  const result = await stopCommand(config, { hooks: { validatePid: async () => false }, output: (line) => lines.push(line) });
  assert.equal(result.stopped, true);
  assert.match(lines[0], /no longer running; releasing its stale ownership/);
  assert.equal(existsSync(config.ownerPath), false);
  assert.equal(existsSync(config.lockPath), false);
});

test("stop refuses a live supervisor that belongs to another checkout", async (t) => {
  const { config, cleanup } = await fixture({ supervisorPid: 4242, checkout: "/checkout/b", supervisorExpectedCommand: "cli.mjs" });
  t.after(cleanup);
  const kills = [];
  await assert.rejects(stopCommand(config, { hooks: { validatePid: async () => true, kill: (...args) => kills.push(args) } }), (error) => error.kind === FailureKind.OWNERSHIP_CONFLICT);
  assert.deepEqual(kills, []);
  assert.match(await readFile(config.ownerPath, "utf8"), /checkout\/b/);
});

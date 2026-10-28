import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "./cli.mjs";

test("status --ready succeeds only for a live, ready owner of this checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chalk-ready-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, CHALK_DEV_STATE_ROOT: root };
  const options = { cwd: root, root, env, output: () => {}, errorOutput: () => {} };
  const status = () => runCli(["status", "--ready"], options);
  const owner = (record) => writeFile(join(root, "owner.json"), JSON.stringify(record));

  assert.equal((await runCli(["status"], options)).code, 0);
  assert.equal((await status()).code, 1);
  await owner({ checkout: root, supervisorPid: process.pid, state: "ready" });
  assert.equal((await status()).code, 0);
  await owner({ checkout: `${root}-other`, supervisorPid: process.pid, state: "ready" });
  assert.equal((await status()).code, 1);
  await owner({ checkout: root, supervisorPid: process.pid, state: "degraded" });
  assert.equal((await status()).code, 1);
  await owner({ checkout: root, supervisorPid: 99999999, state: "ready" });
  assert.equal((await status()).code, 1);
  assert.equal((await runCli(["start", "--ready"], options)).code, 2);
});

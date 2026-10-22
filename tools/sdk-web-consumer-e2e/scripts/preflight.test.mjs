import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("both entrypoints reject a broken adapter before browser setup, then pass the restored contract", () => {
  const source = new URL("../", import.meta.url);
  const directory = mkdtempSync(join(tmpdir(), "chalk-adapter-preflight-"));
  try {
    for (const name of ["scripts", "consumer", "package.json"]) cpSync(new URL(name, source), join(directory, name), { recursive: true });
    symlinkSync(realpathSync(new URL("node_modules", source)), join(directory, "node_modules"));
    const adapter = join(directory, "consumer/media-client.ts");
    const good = readFileSync(adapter, "utf8");
    const broken = good.replace('if (!local) return target.enabled ? { outcome: "terminal_failure", errorCode: "source_unavailable" } : { outcome: "satisfied", errorCode: null };', 'if (!local) return { outcome: "terminal_failure", errorCode: "source_unavailable" };');
    assert.notEqual(broken, good);
    const entrypoints = [
      [process.execPath, [join(directory, "scripts/run.mjs"), "--preflight-only"]],
      ["pnpm", ["--ignore-workspace", "--config.verifyDepsBeforeRun=false", "--dir", directory, "test", "--preflight-only"]],
    ];
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    for (const [command, args] of entrypoints) {
      writeFileSync(adapter, broken);
      const red = spawnSync(command, args, { encoding: "utf8", timeout: 15000, env: environment });
      assert.ifError(red.error);
      assert.notEqual(red.status, 0, red.stdout + red.stderr);
      for (const source of ["microphone", "camera", "screen"]) assert.match(red.stdout + red.stderr, new RegExp(`absent ${source}`));
      writeFileSync(adapter, good);
      const green = spawnSync(command, args, { encoding: "utf8", timeout: 15000, env: environment });
      assert.ifError(green.error);
      assert.equal(green.status, 0, green.stdout + green.stderr);
      assert.match(green.stdout + green.stderr, /tests 5/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

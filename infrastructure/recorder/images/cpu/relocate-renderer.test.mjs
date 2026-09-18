import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./relocate-renderer.mjs", import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "chalk-renderer-relocation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const renderer = join(root, "release", "renderer");
  const self = join(renderer, "node_modules", ".pnpm", "node_modules", "@chalk", "recording-renderer");
  mkdirSync(source);
  mkdirSync(dirname(self), { recursive: true });
  symlinkSync(source, self);
  return { root, source, renderer, self, run: () => spawnSync(process.execPath, [script, renderer, source], { encoding: "utf8" }) };
}

test("relocated deployment keeps its self-link and dependency usable without the checkout", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.renderer, "package.json"), '{"name":"@chalk/recording-renderer"}');
  const dependency = join(f.renderer, "node_modules", "dependency");
  mkdirSync(dependency);
  symlinkSync("dependency", join(f.renderer, "node_modules", "alias"));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readlinkSync(f.self), "../../../..");
  rmSync(f.source, { recursive: true });
  assert.equal(realpathSync(f.self), realpathSync(f.renderer));
  assert.equal(realpathSync(join(f.renderer, "node_modules", "alias")), realpathSync(dependency));
});

test("unrelated checkout dependencies cannot enter the sealed release", (t) => {
  const f = fixture(t);
  symlinkSync(f.root, join(f.renderer, "external"));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /escapes its release/);
});

test("dangling dependencies fail before packaging", (t) => {
  const f = fixture(t);
  symlinkSync("missing", join(f.renderer, "dangling"));
  assert.notEqual(f.run().status, 0);
});

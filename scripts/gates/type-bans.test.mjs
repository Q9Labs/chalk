import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { compareBaseline } from "./explicit-any.mjs";
import { implicitAnyIsForbidden } from "./implicit-any.mjs";

test("Oxlint rejects explicit any and the baseline does not hide an added occurrence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chalk-any-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "example.ts");
  const binary = process.env.OXLINT_BIN ?? resolve("node_modules/.bin/oxlint");
  const run = () => spawnSync(binary, ["-A", "all", "-D", "typescript/no-explicit-any", "-f", "json", source], { encoding: "utf8" });
  await writeFile(source, "const explicit: any = 1;\nconst safe: unknown = 1;\n");
  const bad = run();
  assert.equal(bad.status, 1, bad.stderr);
  assert.equal(JSON.parse(bad.stdout).diagnostics.length, 1);
  await writeFile(source, "const safe: unknown = 1;\n");
  assert.equal(run().status, 0);
  const old = { fingerprint: "old", file: "example.ts" };
  assert.deepEqual(compareBaseline([old, old], [{ fingerprint: "old", count: 1 }]), { added: [old], removed: 0 });
});

test("the shared TypeScript config rejects implicit any", async (t) => {
  assert.equal(implicitAnyIsForbidden({ strict: true }), true);
  assert.equal(implicitAnyIsForbidden({ strict: true, noImplicitAny: false }), false);
  assert.equal(implicitAnyIsForbidden({ strict: false, noImplicitAny: true }), true);
  const root = await mkdtemp(join(tmpdir(), "chalk-implicit-any-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "example.ts"), "export function unsafe(value) { return value; }\n");
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ extends: resolve("tsconfig.json"), compilerOptions: { types: [], noEmit: true }, files: ["example.ts"] }));
  const binary = process.env.TSC_BIN ?? resolve("node_modules/.bin/tsc");
  const result = spawnSync(binary, ["--project", join(root, "tsconfig.json")], { encoding: "utf8", timeout: 60_000 });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /TS7006/u);
});

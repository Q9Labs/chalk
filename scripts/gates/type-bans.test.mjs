import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { compareBaseline, findExplicitAny } from "./explicit-any.mjs";
import { implicitAnyIsForbidden } from "./implicit-any.mjs";

test("syntax rejects explicit any even behind lint and compiler suppressions", () => {
  for (const file of ["example.ts", "example.tsx", "example.mts", "example.cts", "example.d.ts"]) {
    const findings = findExplicitAny(file, "// oxlint-disable\n// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture\n// @ts-nocheck\nexport type Unsafe<T = any> = [any, (...args: any[]) => T];\n");
    assert.equal(findings.length, 3, file);
    assert.ok(findings.every((finding) => finding.file === file && finding.line === 4));
    assert.equal(new Set(findings.map((finding) => finding.fingerprint)).size, 1);
    assert.deepEqual(findExplicitAny(file, 'const any = "any"; // any\ntype Safe = { any: unknown };\n'), []);
  }
});

test("the baseline rejects added, duplicated, moved, changed, and stale exceptions", () => {
  const old = { fingerprint: "old", file: "example.ts" };
  assert.deepEqual(compareBaseline([old, old], [{ fingerprint: "old", count: 1 }]), { added: [old], removed: 0 });
  assert.deepEqual(compareBaseline([], [{ fingerprint: "old", count: 1 }]), { added: [], removed: 1 });
  const [original] = findExplicitAny("example.ts", "type Unsafe = any;");
  const baseline = [{ ...original, count: 1 }];
  for (const changed of [findExplicitAny("example.ts", "type Renamed = any;"), findExplicitAny("moved.ts", "type Unsafe = any;")]) {
    assert.deepEqual(compareBaseline(changed, baseline), { added: changed, removed: 1 });
  }
  assert.deepEqual(compareBaseline(findExplicitAny("example.ts", "\n  type Unsafe = any;\n"), baseline), { added: [], removed: 0 });
});

test("the CLI scans Git-visible TypeScript variants and keeps only the generated exclusions", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chalk-any-cli-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gates = join(root, "scripts/gates");
  await mkdir(gates, { recursive: true });
  await mkdir(join(root, "node_modules"));
  const require = createRequire(import.meta.url);
  await symlink(dirname(require.resolve("typescript/package.json")), join(root, "node_modules/typescript"), "dir");
  await copyFile(new URL("./explicit-any.mjs", import.meta.url), join(gates, "explicit-any.mjs"));
  await writeFile(join(gates, "explicit-any-baseline.json"), "[]\n");
  await writeFile(join(root, ".gitignore"), "node_modules\nignored.ts\n");
  assert.equal(spawnSync("git", ["init", "--quiet", root]).status, 0);
  for (const folder of ["generated", "openapi-generated"]) {
    await mkdir(join(root, folder));
    await writeFile(join(root, folder, "schema.ts"), "type Generated = any;\n");
  }
  await writeFile(join(root, "routeTree.gen.ts"), "type Routes = any;\n");
  await writeFile(join(root, "ignored.ts"), "type Ignored = any;\n");
  const run = () => spawnSync(process.execPath, [join(gates, "explicit-any.mjs")], { cwd: root, encoding: "utf8" });
  for (const file of ["source.ts", "view.tsx", "module.mts", "module.cts", "types.d.ts"]) {
    const path = join(root, file);
    await writeFile(path, "// oxlint-disable\ntype Unsafe = any;\n");
    const result = run();
    assert.equal(result.status, 1, `${file}: ${result.stdout}\n${result.stderr}`);
    assert.ok(result.stderr.includes(`${file}:2`), result.stderr);
    await rm(path);
  }
  await writeFile(join(root, "safe.ts"), "export const value: unknown = 1;\n");
  const safe = run();
  assert.equal(safe.status, 0, safe.stderr);
  assert.match(safe.stdout, /0 existing violations remain across 1 scanned files/u);
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

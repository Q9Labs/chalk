import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { invariants } from "./theory-coverage.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
function sandbox(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chalk-doc-checks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  for (const file of ["scripts/script-entry.mjs", "scripts/gates/doclint.mjs", "scripts/gates/doclint-examples.json", "scripts/gates/theory-coverage.mjs", "scripts/gates/semgrep.sh", ".semgrep/chalk-quality.yml"]) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    copyFileSync(path.join(root, file), path.join(dir, file));
  }
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  write("package.json", JSON.stringify({ scripts: { gate: "node gate.mjs" } }));
  write("packages/example/package.json", JSON.stringify({ scripts: { verify: "node verify.mjs" } }));
  write("README.md", "# Example\n");
  write("docs/ok.md", "# Maintained\n");
  const run = (script) => spawnSync(process.execPath, [`scripts/gates/${script}.mjs`], { cwd: dir, encoding: "utf8" });
  return { dir, write, run };
}

for (const [name, violation, diagnostic] of [
  ["missing relative Markdown target", "[missing](missing.md)", "missing Markdown target: missing.md"],
  ["missing reference-link target", "[missing]: missing.md", "missing Markdown target: missing.md"],
  ["missing repo path", "`apps/web/src/missing.ts`", "missing repo path: apps/web/src/missing.ts"],
  ["unknown explicit pnpm script", "pnpm run invented-script", "unknown pnpm script: invented-script"],
  ["unknown shorthand pnpm script", "pnpm invented-script", "unknown pnpm script: invented-script"],
  ["retired runner guidance", "Run Testbox for the gate.", "retired runner reference"],
]) {
  test(`doclint rejects ${name} with file:line`, (t) => {
    const { write, run } = sandbox(t);
    write("docs/broken.md", `# Example\n\n${violation}\n`);
    const result = run("doclint");
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(`docs/broken.md:3: ${diagnostic}`), result.stderr);
    console.log(result.stderr.trim());
  });
}
test("Markdown links cannot resolve from the repo root instead of the document", (t) => {
  const { write, run } = sandbox(t);
  write("docs/broken.md", "[wrong](README.md)\n");
  assert.match(run("doclint").stderr, /docs\/broken.md:1: missing Markdown target/);
});
test("doclint accepts real links, paths, scripts, built-ins, and exact examples", (t) => {
  const { write, run } = sandbox(t);
  write("docs/valid.md", "[root](../README.md#example)\n`packages/example/package.json`\n`pnpm run gate`\n`pnpm --dir packages/example verify`\n`pnpm install --frozen-lockfile`\n`pnpm exec invented-binary`\n`docs/example.sql`\n");
  write("scripts/gates/doclint-examples.json", JSON.stringify([{ file: "docs/valid.md", path: "docs/example.sql", reason: "Example SQL file, not a repository input." }]));
  const result = run("doclint");
  assert.equal(result.status, 0, result.stderr);
  write("docs/other.md", "`docs/example.sql`\n");
  assert.equal(run("doclint").status, 1, "an example must not exempt another document");
});

const theory = "# Theory\n\n## Contract\n\nA command is durable. <!-- invariant:durable -->\n";
test("theory allows only frozen existing gaps and rejects new or changed requirements", (t) => {
  const { write, run } = sandbox(t);
  write("theory.md", theory);
  write("scripts/gates/theory-baseline.json", JSON.stringify([{ id: "durable", sha256: invariants(theory)[0].hash }]));
  assert.equal(run("theory-coverage").status, 0);
  for (const changed of [theory + "\nA new rule has no id.\n", theory + "\nA new rule has an id. <!-- invariant:new-rule -->\n", theory.replace("durable.", "volatile."), theory.replace(" <!-- invariant:durable -->", "")]) {
    write("theory.md", changed);
    const result = run("theory-coverage");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /theory.md:\d+:/);
    console.log(result.stderr.trim());
  }
});
test("theory validates exact declared test names, not mentions or existing files alone", (t) => {
  const { write, run } = sandbox(t);
  write("scripts/gates/theory-baseline.json", "[]");
  write("proof_test.go", "package proof\n// TestMissing is only a comment.\nfunc TestDurable(t *testing.T) {}\n");
  const mapped = (file, name) => `${theory}\n## Test index\n\n<!-- test:durable ${file}#${name} -->\n`;
  write("theory.md", mapped("proof_test.go", "TestDurable"));
  assert.equal(run("theory-coverage").status, 0);
  for (const [file, name] of [
    ["proof_test.go", "TestMissing"],
    ["missing_test.go", "TestDurable"],
  ]) {
    write("theory.md", mapped(file, name));
    const result = run("theory-coverage");
    assert.equal(result.status, 1, result.stderr);
    console.log(result.stderr.trim());
  }
  write("proof.test.ts", 'it("writes durably", () => {});\n');
  write("theory.md", mapped("proof.test.ts", "writes durably"));
  assert.equal(run("theory-coverage").status, 0);
  write("proof_test.exs", 'test "writes durably" do\nend\n');
  write("theory.md", mapped("proof_test.exs", "writes durably"));
  assert.equal(run("theory-coverage").status, 0);
});
test("theory rejects declarations inside comments", (t) => {
  const { write, run } = sandbox(t);
  write("scripts/gates/theory-baseline.json", "[]");
  for (const [file, name, declaration] of [
    ["proof.test.ts", "writes durably", 'it("writes durably", () => {});'],
    ["proof_test.go", "TestDurable", "func TestDurable(t *testing.T) {}"],
  ]) {
    write("theory.md", `${theory}\n## Test index\n\n<!-- test:durable ${file}#${name} -->\n`);
    for (const source of [`/*\n${declaration}\n*/\n`, `// ${declaration}\n`]) {
      write(file, source);
      const result = run("theory-coverage");
      assert.equal(result.status, 1, `${file}: ${source}\n${result.stdout}`);
      assert.match(result.stderr, /named test does not exist/);
    }
    write(file, `const example = "/* not a comment */ //";\n${declaration}\n`);
    assert.equal(run("theory-coverage").status, 0);
  }
});
test("SDK effect rule rejects named, namespace, and aliased calls in both SDKs", (t) => {
  const { dir, write } = sandbox(t);
  const source = 'import React, { useEffect, useEffect as effect } from "react";\nuseEffect(() => {}, []);\nReact.useEffect(() => {}, []);\neffect(() => {}, []);\n// nosemgrep: chalk.forbid-sdk-use-effect -- Existing fixture cleanup proves a per-call exception.\nuseEffect(() => {}, []);\n';
  for (const sdk of ["react", "react-native"]) write(`sdks/typescript/${sdk}/src/effect.ts`, source);
  write("apps/web/src/effect.ts", source);
  const result = spawnSync("bash", ["scripts/gates/semgrep.sh", "--json", "--quiet", "."], { cwd: dir, encoding: "utf8", timeout: 60_000, env: { ...process.env, SEMGREP_SEND_METRICS: "off" } });
  assert.equal(result.status, 1, result.stderr);
  const matches = JSON.parse(result.stdout).results.filter((finding) => finding.check_id.endsWith("chalk.forbid-sdk-use-effect"));
  assert.equal(matches.length, 6, result.stdout);
  assert.deepEqual(matches.map((finding) => finding.start.line).sort(), [2, 2, 3, 3, 4, 4]);
  for (const finding of matches) console.log(`${finding.path}:${finding.start.line}: rejected SDK useEffect`);
});

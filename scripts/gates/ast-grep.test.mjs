import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

test("ast-grep enforces the migrated rules on real files without flagging allowed cases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chalk-ast-grep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (file, source) => {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
  };
  const effectSource = (suffix) => `import React, { useEffect, useEffect as effect } from "react";\nuseEffect(() => {}, []);\nReact.useEffect(() => {}, []);\neffect(() => {}, []);\n// ast-grep-ignore: chalk.forbid-sdk-use-effect-${suffix} -- Existing lifecycle cleanup.\nuseEffect(() => {}, []);\n`;
  await write("sdks/typescript/react/src/effect.ts", effectSource("ts"));
  await write("sdks/typescript/react-native/src/effect.tsx", effectSource("tsx"));
  await write("sdks/typescript/react/src/no-reason.ts", "// ast-grep-ignore: chalk.forbid-sdk-use-effect-ts\nuseEffect(() => {}, []);\n");
  await write("apps/web/src/effect.ts", effectSource("ts"));
  await write(
    "apps/web/src/checks.ts",
    `eval("bad");\nnew Function("bad");\nsetTimeout("bad", 10);\nsetInterval(\`bad\`, 10);\nsetTimeout(handler, 10, "safe argument");\n// @ts-ignore\nconsole.log("bad");\nprocess.env.FOO;\nlocalStorage.setItem("token", value);\nlocalStorage.setItem("theme", value);\n// oxlint-disable-next-line typescript/no-explicit-any\nconst unsafe: any = value;\n// oxlint-disable-next-line typescript/no-explicit-any -- Legacy interop boundary.\nconst allowed: any = value;\n`,
  );
  await write("apps/web/src/checks.test.ts", `test.only("bad", () => {});\ndescribe.skip("bad", () => {});\n`);
  await write("sdks/typescript/client/src/import.ts", `import { x } from "../../../apps/web/x";\n`);
  await write("scripts/unsafe.mjs", `spawn("echo", [], { shell: true });\n`);
  await write("packages/fixture/package.json", '{"scripts":{"test":"true","lint":"echo \'No linter configured yet\'"},"exports":{"import":"./src/index.js"}}');
  await write("apps/api/openapi.yaml", "x-generated-stub: true\n# TODO: document this\n");

  const runner = resolve("scripts/gates/ast-grep.mjs");
  const result = spawnSync(process.execPath, [runner, "--json", "."], { cwd: root, encoding: "utf8", timeout: 60_000, env: process.env });
  assert.equal(result.status, 1, result.stderr);
  let findings;
  try {
    findings = JSON.parse(result.stdout);
  } catch {
    assert.fail(`Expected JSON findings, got: ${result.stdout}\n${result.stderr}`);
  }
  const counts = new Map();
  for (const finding of findings) counts.set(finding.ruleId, (counts.get(finding.ruleId) ?? 0) + 1);
  for (const [id, count] of [
    ["chalk.forbid-sdk-use-effect-ts", 3],
    ["chalk.forbid-sdk-use-effect-tsx", 3],
    ["chalk.forbid-dynamic-code-ts", 2],
    ["chalk.forbid-string-timers-ts", 2],
    ["chalk.forbid-focused-or-skipped-tests-ts", 2],
    ["chalk.forbid-unjustified-ts-ignore-ts", 1],
    ["chalk.forbid-unjustified-suppression-ts", 2],
    ["chalk.forbid-console-in-app-code-ts", 1],
    ["chalk.forbid-direct-process-env-ts", 1],
    ["chalk.forbid-raw-token-storage-ts", 1],
    ["chalk.forbid-sdk-importing-app-code-ts", 1],
    ["chalk.forbid-shell-true-with-interpolation-js", 1],
    ["chalk.forbid-placeholder-scripts-json", 2],
    ["chalk.forbid-source-path-package-exports-json", 1],
    ["chalk.forbid-generated-openapi-stubs-yaml", 2],
  ])
    assert.equal(counts.get(id), count, `${id}: ${JSON.stringify([...counts])}`);
  assert.equal(
    findings.length,
    [...counts.values()].reduce((sum, count) => sum + count, 0),
  );
  assert.equal(findings.length, 25, JSON.stringify(findings.map(({ ruleId, file, range }) => ({ ruleId, file, range }))));
});

test("SDK effect review covers call forms but does not ban test lifecycle probes or external stores", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chalk-sdk-effects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, source) => {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, source);
  };
  const source = `import React, { useEffect, useEffect as synchronize, useSyncExternalStore } from "react";
useEffect(subscribe, []);
React.useEffect(subscribe, []);
synchronize(subscribe, []);
// ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [subscription] Observe the external store; unsubscribe on cleanup.
useEffect(subscribe, []);
useSyncExternalStore(subscribe, snapshot, serverSnapshot);
`;
  for (const sdk of ["react", "react-native"]) {
    await write(`sdks/typescript/${sdk}/src/production.tsx`, source);
    for (const path of ["src/probe.test.tsx", "src/probe.spec.tsx", "src/__tests__/probe.tsx", "test/probe.tsx", "tests/probe.tsx", "dist/probe.tsx"]) await write(`sdks/typescript/${sdk}/${path}`, source);
  }
  await write("sdks/typescript/react/src/unjustified.ts", "// ast-grep-ignore: chalk.forbid-sdk-use-effect-ts\nuseEffect(subscribe, []);\n");
  await write("apps/web/src/consumer.tsx", source);
  const result = spawnSync(process.execPath, [resolve("scripts/gates/ast-grep.mjs"), "--json", "."], { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 1, result.stderr);
  const findings = JSON.parse(result.stdout);
  const effects = findings.filter(({ ruleId }) => ruleId.startsWith("chalk.forbid-sdk-use-effect-"));
  assert.equal(effects.length, 6, JSON.stringify(findings));
  assert.ok(effects.every(({ file }) => file.endsWith("production.tsx")));
  assert.deepEqual(
    effects.map(({ range }) => range.start.line),
    [1, 2, 3, 1, 2, 3],
  );
  assert.equal(findings.filter(({ ruleId }) => ruleId === "chalk.forbid-unjustified-suppression-ts").length, 1);
  assert.equal(findings.length, 7, JSON.stringify(findings));
});

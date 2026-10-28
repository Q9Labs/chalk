import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

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

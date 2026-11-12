import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "ast-grep.mjs");

// Each entry is one test file. The ban must catch every way a test can name our own module, and leave real boundaries alone.
const banned = {
  "plain.test.ts": 'import { vi } from "vitest";\nvi.mock("./own", () => ({}));',
  "import-expression.test.ts": 'import { vi } from "vitest";\nvi.mock(import("./own"), () => ({}));',
  "import-expression-do-mock.test.ts": 'import { vi } from "vitest";\nvi.doMock(import("../own"));',
  "template.test.ts": 'import { vi } from "vitest";\nvi.mock(`./own`, () => ({}));',
  "aliased-vi.test.ts": 'import { vi as v } from "vitest";\nv.doMock("./own", () => ({}));',
  "namespace-vitest.test.ts": 'import * as vitest from "vitest";\nvitest.vi.mock("@chalk/own", () => ({}));',
  "destructured-vi.test.ts": 'import { vi } from "vitest";\nconst { mock } = vi;\nmock("./own", () => ({}));',
  "hoisted.test.ts": 'import { vi } from "vitest";\nvi.hoisted(() => { vi.mock("./own", () => ({})); });',
  "node-test-module.test.mjs": 'import { mock } from "node:test";\nmock.module("./own.mjs", { namedExports: {} });',
  "node-test-alias.test.mjs": 'import { mock as m } from "node:test";\nm.module("../own.mjs", {});',
  "node-test-context.test.mjs": 'import test from "node:test";\ntest("x", (t) => { t.mock.module("./own.mjs", {}); });',
  "module-ts.test.mts": 'import { vi } from "vitest";\nvi.mock("./own.mjs", () => ({}));',
  "common-js.test.cjs": 'jest.mock("./own.cjs");',
  "jsx.test.jsx": 'import { vi } from "vitest";\nvi.mock("./own", () => ({}));',
  "jest.test.js": 'jest.mock("./own");',
  "tests-dir-helper/tests/helper.ts": 'import { vi } from "vitest";\nvi.mock("./own", () => ({}));',
  "setup.setup.ts": 'import { vi } from "vitest";\nvi.mock("./own", () => ({}));',
};
const allowed = {
  "package.test.ts": 'import { vi } from "vitest";\nvi.mock("react-native", () => ({}));',
  "package-import-expression.test.ts": 'import { vi } from "vitest";\nvi.mock(import("react-native"), () => ({}));',
  "node-test-package.test.mjs": 'import { mock } from "node:test";\nmock.module("node:fs", {});',
  "method.test.mjs": 'import { mock } from "node:test";\nmock.method(globalThis, "fetch", async () => new Response());',
};

function rulesHit(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chalk-ast-grep-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), `${source}\n`);
    }
    const result = spawnSync(process.execPath, [script, "--json=compact", ...Object.keys(files)], { cwd: root, encoding: "utf8" });
    assert.ok(result.stdout.trim().startsWith("["), result.stderr || result.stdout);
    const hits = new Map(Object.keys(files).map((name) => [name, []]));
    for (const match of JSON.parse(result.stdout)) hits.get(match.file)?.push(match.ruleId);
    return hits;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a test cannot replace a module of this repository, however it names the mock call or the module", () => {
  const hits = rulesHit(banned);
  const missed = [...hits].filter(([, ruleIds]) => !ruleIds.some((id) => id.startsWith("chalk.forbid-own-module-mocks-"))).map(([name]) => name);
  assert.deepEqual(missed, []);
});

test("mocking a package or a global, and node:test mock.method, stay allowed", () => {
  for (const [name, ruleIds] of rulesHit(allowed)) assert.deepEqual(ruleIds, [], name);
});

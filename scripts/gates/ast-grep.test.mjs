import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "ast-grep.mjs");

// Each entry is one file. The ban must catch every way a test can name our own module, in any file, and leave real boundaries alone.
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
  "src/mock-own.ts": 'import { vi } from "vitest";\nexport const mockOwn = () => vi.doMock("./own", () => ({}));',
};
const allowed = {
  "package.test.ts": 'import { vi } from "vitest";\nvi.mock("react-native", () => ({}));',
  "package-import-expression.test.ts": 'import { vi } from "vitest";\nvi.mock(import("react-native"), () => ({}));',
  "node-test-package.test.mjs": 'import { mock } from "node:test";\nmock.module("node:fs", {});',
  "method.test.mjs": 'import { mock } from "node:test";\nmock.method(globalThis, "fetch", async () => new Response());',
};
// ast-grep honors these comments and hides the mock call (a trailing blanket one hides itself too), so the script rejects them as text.
const suppressed = {
  "named.test.ts": 'import { vi } from "vitest";\n// ast-grep-ignore: chalk.forbid-own-module-mocks-ts -- reason\nvi.mock("./own", () => ({}));',
  "blanket.test.ts": 'import { vi } from "vitest";\n// ast-grep-ignore\nvi.mock("./own", () => ({}));',
  "trailing-blanket.test.ts": 'import { vi } from "vitest";\nvi.mock("./own", () => ({})); // ast-grep-ignore',
  "multiline-block.test.ts": '/* ast-grep-ignore:\nchalk.forbid-own-module-mocks-ts -- reason */\nimport { vi } from "vitest";\nvi.mock("./own", () => ({}));',
  "url-string-before-block.test.ts": 'import { vi } from "vitest";\nvi.mock("./own", () => ({ default: "https://example.test" })); /* ast-grep-ignore:\nchalk.forbid-own-module-mocks-ts -- reason */',
  "blanket-in-helper.ts": 'import { vi } from "vitest";\nvi.doMock("./own", () => ({})); // ast-grep-ignore -- reason',
};

function scan(files, args) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chalk-ast-grep-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), `${source}\n`);
    }
    return spawnSync(process.execPath, [script, ...args, ...Object.keys(files)], { cwd: root, encoding: "utf8" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function rulesHit(files) {
  const result = scan(files, ["--json=compact"]);
  assert.ok(result.stdout.trim().startsWith("["), result.stderr || result.stdout);
  const hits = new Map(Object.keys(files).map((name) => [name, []]));
  for (const match of JSON.parse(result.stdout)) hits.get(match.file)?.push(match.ruleId);
  return hits;
}

test("a test cannot replace a module of this repository, however it names the mock call or the module, or what file holds the call", () => {
  const missed = [...rulesHit(banned)].filter(([, ruleIds]) => !ruleIds.some((id) => id.startsWith("chalk.forbid-own-module-mocks-"))).map(([name]) => name);
  assert.deepEqual(missed, []);
});

test("mocking a package or a global, and node:test mock.method, stay allowed", () => {
  for (const [name, ruleIds] of rulesHit(allowed)) assert.deepEqual(ruleIds, [], name);
});

test("the own-module mock ban cannot be switched off with an ast-grep-ignore comment", () => {
  for (const [name, source] of Object.entries(suppressed)) {
    const result = scan({ [name]: source }, []);
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /Name the rule you suppress/u, name);
  }
});

test("a suppression that names another rule is still allowed", () => {
  const result = scan({ "other.ts": "// ast-grep-ignore: chalk.forbid-console-in-app-code -- reason\nconsole.log(1);" }, []);
  assert.doesNotMatch(result.stderr, /Name the rule you suppress/u);
});

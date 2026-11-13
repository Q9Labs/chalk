import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mock-calls.mjs");
const baselineFile = "scripts/gates/mock-call-baseline.json";

// A scratch repository: `main` holds the base baseline, the checked-out branch holds `assertions` mock-call assertions and the baseline under test.
function scratch(t, { base, baseline, assertions, assertion = "expect(callback).toHaveBeenCalled();" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chalk-mock-calls-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "gate@example.com");
  git("config", "user.name", "Gate");
  write("pkg/package.json", "{}\n");
  write(baselineFile, `${JSON.stringify(base)}\n`);
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  write("pkg/a.test.ts", Array.from({ length: assertions }, () => assertion).join("\n"));
  write(baselineFile, `${JSON.stringify(baseline)}\n`);
  git("add", ".");
  git("commit", "-q", "-m", "feature");
  const run = (args = [], env = {}) => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, MOCK_CALLS_ROOT: root, GATE_BASE_REF: "main", ...env } });
    return { status: result.status, output: result.stderr + result.stdout };
  };
  return { run, committedBaseline: () => JSON.parse(fs.readFileSync(path.join(root, baselineFile), "utf8")) };
}

test("a count equal to the baseline passes", (t) => {
  assert.equal(scratch(t, { base: { pkg: 2 }, baseline: { pkg: 2 }, assertions: 2 }).run().status, 0);
});

test("a new assertion above the baseline fails", (t) => {
  const result = scratch(t, { base: { pkg: 2 }, baseline: { pkg: 2 }, assertions: 3 }).run();
  assert.equal(result.status, 1);
  assert.match(result.output, /pkg: 3 assertions on mock calls, baseline 2/u);
});

test("node:test's fn.mock.callCount() counts as an assertion on a mock call", (t) => {
  const result = scratch(t, { base: { pkg: 0 }, baseline: { pkg: 0 }, assertions: 1, assertion: "assert.equal(callback.mock.callCount(), 1);" }).run();
  assert.equal(result.status, 1);
  assert.match(result.output, /pkg: 1 assertions on mock calls, baseline 0/u);
});

test("removing assertions fails until the baseline is lowered, so they cannot come back", (t) => {
  const result = scratch(t, { base: { pkg: 3 }, baseline: { pkg: 3 }, assertions: 1 }).run();
  assert.equal(result.status, 1);
  assert.match(result.output, /--update/u);
});

test("a baseline raised by hand fails against the base branch even when the count matches it", (t) => {
  const result = scratch(t, { base: { pkg: 1 }, baseline: { pkg: 3 }, assertions: 3 }).run();
  assert.equal(result.status, 1);
  assert.match(result.output, /pkg: baseline 3 is above 1 on main/u);
});

test("a package that is new to the baseline counts from zero on the base branch", (t) => {
  const result = scratch(t, { base: {}, baseline: { pkg: 1 }, assertions: 1 }).run();
  assert.equal(result.status, 1);
  assert.match(result.output, /pkg: baseline 1 is above 0 on main/u);
});

test("--update refuses to raise a count and leaves the baseline alone", (t) => {
  const repo = scratch(t, { base: { pkg: 1 }, baseline: { pkg: 1 }, assertions: 3 });
  const result = repo.run(["--update"]);
  assert.equal(result.status, 1);
  assert.deepEqual(repo.committedBaseline(), { pkg: 1 });
});

test("--update lowers the baseline after assertions were removed, and the check then passes", (t) => {
  const repo = scratch(t, { base: { pkg: 3 }, baseline: { pkg: 3 }, assertions: 1 });
  assert.equal(repo.run(["--update"]).status, 0);
  assert.deepEqual(repo.committedBaseline(), { pkg: 1 });
  assert.equal(repo.run().status, 0);
});

test("a base that cannot be read fails the check instead of skipping the comparison", (t) => {
  const result = scratch(t, { base: { pkg: 2 }, baseline: { pkg: 2 }, assertions: 2 }).run([], { GATE_BASE_REF: "no-such-ref" });
  assert.equal(result.status, 1);
  assert.match(result.output, /Cannot read scripts\/gates\/mock-call-baseline\.json on the merge base with no-such-ref/u);
});

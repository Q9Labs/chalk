import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// A staging lease argument that staging-lock rejects must fail the pull request, not the nightly cut.
const root = new URL("../../", import.meta.url);
const text = (path) => readFileSync(new URL(path, root), "utf8");

const labelSource = /def label\(value\):\s+if not re\.fullmatch\(r"([^"]+)", value\)/u.exec(text("scripts/staging-sfu/staging-lock"))?.[1];
const labelPattern = new RegExp(`^${labelSource}$`, "u");
const gateLease = /staging-sfu\/gate-lease\s+(\S+)\s+("[^"]*"|\S+)\s+("[^"]*"|\S+)\s+--(?:\s|$)/u;
const stagingLock = /staging-sfu\/staging-lock\s.*?--holder\s+(\S+)\s.*?--purpose\s+(\S+)\s.*?--run-id\s+("[^"]*"|\S+)/u;

function workflowFiles() {
  const workflows = readdirSync(new URL(".github/workflows/", root))
    .filter((name) => name.endsWith(".yml"))
    .map((name) => `.github/workflows/${name}`);
  const actions = readdirSync(new URL(".github/actions/", root)).map((name) => `.github/actions/${name}/action.yml`);
  return [...workflows, ...actions.filter((path) => existsSync(new URL(path, root)))];
}

function leaseCalls() {
  return workflowFiles().flatMap((file) =>
    text(file)
      .split("\n")
      .flatMap((line, index) => {
        const match = gateLease.exec(line) ?? stagingLock.exec(line);
        if (!match) return [];
        const [holder, purpose, runId] = match.slice(1).map((value) => value.replaceAll('"', ""));
        return [{ where: `${file}:${index + 1}`, holder, purpose, runId }];
      }),
  );
}

test("the label pattern is read from staging-lock", () => {
  assert.ok(labelPattern.test("nightly-proof"));
  assert.ok(!labelPattern.test("a b"));
  assert.ok(!labelPattern.test("x".repeat(101)));
});

test("every workflow lease call passes staging-lock's label check", () => {
  const calls = leaseCalls();
  assert.ok(calls.length >= 4, `the scan found only ${calls.length} lease calls`);
  for (const { where, holder, purpose, runId } of calls) {
    // A holder and a purpose are literal labels: an expansion such as ${proofs[*]} can hold spaces.
    for (const [name, value] of [
      ["holder", holder],
      ["purpose", purpose],
    ]) {
      assert.ok(labelPattern.test(value), `${where}: the ${name} ${JSON.stringify(value)} is not a plain label`);
    }
    assert.ok(labelPattern.test(runId.replace(/\$\{?[A-Za-z_]+\}?/gu, "1")), `${where}: the run id ${JSON.stringify(runId)} is not a plain label`);
  }
});

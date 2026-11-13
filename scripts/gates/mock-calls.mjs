#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Ratchet for assertions on mock calls. Lint cannot judge one: asserting that a callback the test passed in was called
// is a real output, while asserting that our own wiring called a mock proves nothing a user sees. So the count per
// package may only go down. A drop must be written to the baseline with `--update`, which refuses to raise a count. The
// check also reads the baseline on the merge base with the pull request's base branch and fails when the committed one is higher.
const scriptDir = dirname(fileURLToPath(import.meta.url));
// MOCK_CALLS_ROOT points the script at another checkout, so its test can run it in a scratch repository.
const root = resolve(process.env.MOCK_CALLS_ROOT ?? resolve(scriptDir, "../.."));
const baselineFile = "scripts/gates/mock-call-baseline.json";
const baselinePath = resolve(root, baselineFile);
const require = createRequire(import.meta.url);
const ts = require("typescript");

const matcher = /^(?:toHaveBeen(?:Last|Nth)?Called|toBeCalled|toHaveReturned|toHaveLastReturned|toHaveNthReturned|toHaveResolved|toHaveLastResolved|toHaveNthResolved|lastCalledWith|nthCalledWith)/u;
const mockState = new Set(["calls", "lastCall", "results"]);
const testFile = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|\/)__tests__\/.*\.[cm]?[jt]sx?)$/u;

/** node:test reads the number of calls with `fn.mock.callCount()`. */
function isMockCallCount(callee) {
  return callee.name.text === "callCount" && ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === "mock";
}

/** Counts matcher calls such as `expect(x).toHaveBeenCalledWith(...)` and reads of `fn.mock.calls`. */
export function countMockCallAssertions(file, source) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let count = 0;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && (matcher.test(node.expression.name.text) || isMockCallCount(node.expression))) count++;
    else if (ts.isPropertyAccessExpression(node) && mockState.has(node.name.text) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "mock") count++;
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return count;
}

function packageOf(file, directories) {
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    if (directories.has(directory)) return directory;
    if (directory === ".") return ".";
  }
}

function countByPackage() {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const directories = new Set(listed.filter((file) => file.endsWith("/package.json")).map((file) => dirname(file)));
  const counts = {};
  for (const file of listed.filter((candidate) => testFile.test(candidate) && existsSync(resolve(root, candidate)))) {
    const count = countMockCallAssertions(file, readFileSync(resolve(root, file), "utf8"));
    if (count > 0) counts[packageOf(file, directories)] = (counts[packageOf(file, directories)] ?? 0) + count;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/** One problem per package whose count is above the baseline. `--update` refuses to write while any exists. */
function raisedProblems(counts, baseline) {
  return Object.entries(counts)
    .filter(([directory, count]) => count > (baseline[directory] ?? 0))
    .map(([directory, count]) => `${directory}: ${count} assertions on mock calls, baseline ${baseline[directory] ?? 0}. Assert on what a caller or user observes, or fake only the real boundary.`);
}

/** Problems with `counts` against the committed baseline, and with the committed baseline against the one on the base branch. */
function ratchetProblems({ counts, baseline, base, baseRef }) {
  const problems = raisedProblems(counts, baseline);
  for (const directory of Object.keys({ ...baseline, ...counts })) {
    const count = counts[directory] ?? 0;
    const committed = baseline[directory] ?? 0;
    if (count < committed) problems.push(`${directory}: ${count} assertions on mock calls, baseline ${committed}. Run \`node scripts/gates/mock-calls.mjs --update\` to lower the baseline, so the removed assertions cannot come back.`);
    if (committed > (base[directory] ?? 0)) problems.push(`${directory}: baseline ${committed} is above ${base[directory] ?? 0} on ${baseRef}. The baseline may only go down.`);
  }
  return problems;
}

/** The baseline as committed on the merge base with `ref`. Throws when it cannot be read, so a shallow clone fails the gate. */
function readBaseBaseline(ref, cwd = root) {
  try {
    const mergeBase = execFileSync("git", ["merge-base", ref, "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return JSON.parse(execFileSync("git", ["show", `${mergeBase}:${baselineFile}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    throw new Error(`Cannot read ${baselineFile} on the merge base with ${ref}, so the ratchet cannot be checked. Fetch the full history and the base branch (git fetch --unshallow origin), or set GATE_BASE_REF. ${error.message}`, { cause: error });
  }
}

function run() {
  const counts = countByPackage();
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (process.argv.includes("--update")) {
    const raised = raisedProblems(counts, baseline);
    for (const problem of raised) console.error(`${problem} --update only lowers the baseline.`);
    if (raised.length) {
      process.exitCode = 1;
      return;
    }
    writeFileSync(baselinePath, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`Wrote ${baselinePath}`);
    return;
  }
  const baseRef = process.env.GATE_BASE_REF || "origin/master";
  const problems = ratchetProblems({ counts, baseline, base: readBaseBaseline(baseRef), baseRef });
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    process.exitCode = 1;
    return;
  }
  console.log("Assertions on mock calls match the baseline, and the baseline did not rise.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();

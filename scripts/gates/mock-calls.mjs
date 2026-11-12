#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Ratchet for assertions on mock calls. Lint cannot judge one: asserting that a callback the test passed in was called
// is a real output, while asserting that our own wiring called a mock proves nothing a user sees. So the count per
// package may only go down. `--update` rewrites the baseline after a drop.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "../..");
const baselinePath = resolve(scriptDir, "mock-call-baseline.json");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const matcher = /^(?:toHaveBeen(?:Last|Nth)?Called|toBeCalled|toHaveReturned|toHaveLastReturned|toHaveNthReturned|toHaveResolved|toHaveLastResolved|toHaveNthResolved|lastCalledWith|nthCalledWith)/u;
const mockState = new Set(["calls", "lastCall", "results"]);
const testFile = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|\/)__tests__\/.*\.[cm]?[jt]sx?)$/u;

/** Counts matcher calls such as `expect(x).toHaveBeenCalledWith(...)` and reads of `fn.mock.calls`. */
export function countMockCallAssertions(file, source) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let count = 0;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && matcher.test(node.expression.name.text)) count++;
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

function run() {
  const counts = countByPackage();
  if (process.argv.includes("--update")) {
    writeFileSync(baselinePath, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`Wrote ${baselinePath}`);
    return;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const raised = Object.entries(counts).filter(([directory, count]) => count > (baseline[directory] ?? 0));
  const lowered = Object.keys({ ...baseline, ...counts }).filter((directory) => (counts[directory] ?? 0) < (baseline[directory] ?? 0));
  for (const [directory, count] of raised) console.error(`${directory}: ${count} assertions on mock calls, baseline ${baseline[directory] ?? 0}. Assert on what a caller or user observes, or fake only the real boundary.`);
  if (raised.length) {
    process.exitCode = 1;
    return;
  }
  if (lowered.length) console.log(`Counts fell in ${lowered.join(", ")}. Run \`node scripts/gates/mock-calls.mjs --update\` to lower the baseline.`);
  console.log("Assertions on mock calls did not grow.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();

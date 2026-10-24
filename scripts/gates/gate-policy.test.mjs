import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { load } from "js-yaml";

const workflow = (name) => load(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"));

test("daily workflow keeps every finding red and serializes standing issue creation", () => {
  const daily = workflow("osv-daily");
  assert.deepEqual(daily.concurrency, { group: "daily-osv-issue", "cancel-in-progress": false, queue: "max" });
  assert.deepEqual(daily.jobs.scan.permissions, { contents: "read", issues: "write" });
  const scan = daily.jobs.scan.steps.find((step) => step.id === "osv");
  assert.equal(scan.run, "bash scripts/gates/osv-scanner.sh");
  assert.equal(Object.hasOwn(scan, "continue-on-error"), false);
  assert.equal(Object.hasOwn(daily, "env"), false);
  assert.equal(Object.hasOwn(daily.jobs.scan, "env"), false);
  assert.equal(Object.hasOwn(scan, "env"), false);
  const report = daily.jobs.scan.steps.at(-1);
  assert.equal(report.if, "failure() && steps.osv.outcome == 'failure'");
});

test("the real daily issue step creates one labelled issue, then reopens and comments", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "chalk-osv-issue-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "bin"));
  writeFileSync(
    path.join(root, "bin/gh"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[0] !== 'issue') process.exit(0);
if (args[1] === 'list' && fs.existsSync(process.env.STATE)) console.log('42');
if (args[1] === 'create') {
  if (fs.existsSync(process.env.STATE)) process.exit(1);
  fs.writeFileSync(process.env.STATE, '42');
  console.log('https://github.com/fixture/repo/issues/42');
}
`,
    { mode: 0o755 },
  );
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, CALLS: path.join(root, "calls"), STATE: path.join(root, "state"), GITHUB_REPOSITORY: "fixture/repo", GITHUB_RUN_ID: "77", GITHUB_SERVER_URL: "https://github.com" };
  const report = workflow("osv-daily").jobs.scan.steps.at(-1);
  for (let index = 0; index < 2; index++) {
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", report.run], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const calls = readFileSync(env.CALLS, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const issues = calls.filter(([command]) => command === "issue");
  assert.equal(issues.filter(([, action]) => action === "create").length, 1);
  const lists = issues.filter(([, action]) => action === "list");
  assert.equal(lists.length, 2);
  for (const args of lists) {
    assert.equal(args[args.indexOf("--label") + 1], "security-osv-daily");
    assert.equal(args[args.indexOf("--state") + 1], "all");
  }
  assert.ok(issues.some(([, action, number]) => action === "reopen" && number === "42"));
  const comment = issues.find(([, action]) => action === "comment");
  assert.equal(comment[2], "42");
  assert.ok(comment.includes("Daily full OSV scan failed: https://github.com/fixture/repo/actions/runs/77. This scan has no baseline; review every finding in the scan output."));
});

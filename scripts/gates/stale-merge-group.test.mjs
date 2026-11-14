import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/gate.yml", import.meta.url), "utf8");
const stepName = "Stop when the merge group is gone";

// The run block of every copy of the step, as the runner would receive it.
function stepScripts() {
  const lines = workflow.split("\n");
  const scripts = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() !== `- name: ${stepName}`) continue;
    const start = lines.findIndex((candidate, at) => at > index && candidate.trim() === "run: |");
    const body = [];
    for (const next of lines.slice(start + 1)) {
      if (next.trim() !== "" && !next.startsWith("          ")) break;
      body.push(next.slice(10));
    }
    scripts.push(body.join("\n"));
  }
  return scripts;
}

// Run 43350027639 of PR 1293: its group was destroyed when a queue jump rebuilt the groups, and it kept running.
const observed = {
  GITHUB_REPOSITORY: "Q9Labs/chalk",
  GITHUB_REF: "refs/heads/gh-readonly-queue/master/pr-1293-23359a03f9f25431fd1057f3aff841805a062ba5",
  GITHUB_SHA: "c80b7296bc70529abdfd45c668e855c8afb73908",
  GITHUB_RUN_ID: "43350027639",
  API_TOKEN: "token",
};

// git and curl are stubs: git answers like `git ls-remote` for the group's branch, curl records the request it gets.
function run(script, { gitOutput, gitStatus, curlStatus = 0 }) {
  const directory = mkdtempSync(join(tmpdir(), "stale-group-"));
  const log = join(directory, "curl.log");
  writeFileSync(join(directory, "git"), `#!/bin/bash\nprintf '%s' "$STUB_GIT_OUTPUT"\nexit "$STUB_GIT_STATUS"\n`);
  writeFileSync(join(directory, "curl"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "$STUB_CURL_LOG"\nexit "$STUB_CURL_STATUS"\n`);
  chmodSync(join(directory, "git"), 0o755);
  chmodSync(join(directory, "curl"), 0o755);
  const result = spawnSync("bash", ["-e", "-c", script], {
    encoding: "utf8",
    env: {
      ...observed,
      PATH: `${directory}:${process.env.PATH}`,
      STUB_GIT_OUTPUT: gitOutput,
      STUB_GIT_STATUS: String(gitStatus),
      STUB_CURL_LOG: log,
      STUB_CURL_STATUS: String(curlStatus),
    },
  });
  let requests = "";
  try {
    requests = readFileSync(log, "utf8");
  } catch {
    // curl never ran
  }
  return { status: result.status, requests };
}

test("every job that can wait for a runner carries the same stale-group step", () => {
  const scripts = stepScripts();
  assert.equal(scripts.length, 4);
  assert.equal(new Set(scripts).size, 1);
});

for (const [index, script] of stepScripts().entries()) {
  test(`copy ${index + 1}: a group branch at this run's commit keeps the job running`, () => {
    const outcome = run(script, { gitOutput: `${observed.GITHUB_SHA}\t${observed.GITHUB_REF}\n`, gitStatus: 0 });
    assert.equal(outcome.status, 0);
    assert.equal(outcome.requests, "");
  });

  test(`copy ${index + 1}: a deleted group branch force-cancels the run and fails the job`, () => {
    const outcome = run(script, { gitOutput: "", gitStatus: 2 });
    assert.equal(outcome.status, 1);
    assert.match(outcome.requests, /-X POST .*https:\/\/api\.github\.com\/repos\/Q9Labs\/chalk\/actions\/runs\/43350027639\/force-cancel/u);
  });

  test(`copy ${index + 1}: a group branch recreated at another commit force-cancels the run`, () => {
    const outcome = run(script, { gitOutput: `07bf4236ee9620185993b342716669c7ec15af4c\t${observed.GITHUB_REF}\n`, gitStatus: 0 });
    assert.equal(outcome.status, 1);
    assert.match(outcome.requests, /actions\/runs\/43350027639\/force-cancel/u);
  });

  test(`copy ${index + 1}: a failed lookup never cancels a run`, () => {
    const outcome = run(script, { gitOutput: "", gitStatus: 128 });
    assert.equal(outcome.status, 0);
    assert.equal(outcome.requests, "");
  });

  test(`copy ${index + 1}: a failed cancel request still fails the job`, () => {
    const outcome = run(script, { gitOutput: "", gitStatus: 2, curlStatus: 22 });
    assert.notEqual(outcome.status, 0);
  });
}

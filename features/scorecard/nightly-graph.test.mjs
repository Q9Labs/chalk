import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

// The Cloudflare latency job is warn-only, so the workflow graph must keep it out of every job that feeds a verdict.
test("no job needs the Cloudflare latency job except its own history step", () => {
  const nightly = read(".github/workflows/nightly.yml");
  const jobs = new Map([...nightly.matchAll(/^ {2}([a-z0-9-]+):\n((?: {4}.*\n|\n)*)/gm)].map((match) => [match[1], match[2]]));
  const needs = (name) => (jobs.get(name)?.match(/^ {4}needs: \[(.*)\]$/m)?.[1] ?? "").split(",").map((item) => item.trim());
  assert.ok(jobs.has("cf-sfu-latency") && jobs.has("cf-sfu-history"));
  for (const name of jobs.keys()) {
    const cloudflare = needs(name).filter((item) => item.startsWith("cf-sfu"));
    if (name === "cf-sfu-history") assert.deepEqual(cloudflare, ["cf-sfu-latency"]);
    else assert.deepEqual(cloudflare, [], `${name} must not need a Cloudflare job`);
  }
  for (const verdict of ["scorecard", "record", "github-release"]) assert.ok(jobs.has(verdict), `${verdict} job exists`);
  assert.match(jobs.get("cf-sfu-history") ?? "", /^ {4}if: always\(\)/m);
  assert.match(jobs.get("cf-sfu-history") ?? "", /SCORECARD_WARN_ONLY: "true"/);
});

test("the gate's scorecard download cannot match the Cloudflare card", () => {
  const nightly = read(".github/workflows/nightly.yml");
  const glob = /pattern: (scorecard-nightly-\*)/.exec(nightly)?.[1];
  assert.ok(glob, "the scorecard job downloads scorecard-nightly-*");
  assert.match(read(".github/workflows/real-call-proof.yml"), /latency_only && inputs\.media_plane == 'cf_sfu' && 'warn-scorecard' \|\| 'scorecard'/);
  // The glob is one trailing star, so it matches exactly the names that start with its prefix.
  assert.equal(glob.indexOf("*"), glob.length - 1);
  const matches = (name) => name.startsWith(glob.slice(0, -1));
  assert.equal(matches("scorecard-nightly-chalk_sfu"), true);
  assert.equal(matches("warn-scorecard-nightly-cf_sfu"), false);
});

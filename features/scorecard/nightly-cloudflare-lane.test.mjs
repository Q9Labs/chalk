import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { load } from "js-yaml";

const root = resolve(import.meta.dirname, "../..");
const workflow = (name) => load(readFileSync(resolve(root, ".github/workflows", name), "utf8"));

test("Only the Cloudflare plane lane receives the real Cloudflare credentials", () => {
  const lane = workflow("nightly-proofs.yml").jobs.lane;
  const boot = lane.steps.find((item) => item.name === "Boot the stack");
  const names = Object.keys(boot.env).filter((name) => name.startsWith("CHALK_STACK_CLOUDFLARE_"));
  assert.equal(names.length, 5);
  for (const name of names) assert.match(boot.env[name], /^\$\{\{ matrix\.proof == 'cloudflare-plane' && secrets\.CHALK_CLOUDFLARE_[A-Z_]+ \|\| '' \}\}$/);
  for (const step of lane.steps.filter((item) => /^(Refuse a pull|Require the revision to be merged)/.test(item.name))) {
    assert.match(step.if, /matrix\.proof == 'cloudflare-plane'/, `${step.name} also guards the Cloudflare credentials`);
  }
  const others = JSON.stringify(lane.steps.filter((item) => item !== boot));
  assert.doesNotMatch(others, /secrets\.CHALK_CLOUDFLARE_/);
});

test("The Nightly gate holds no Axiom token: its stack has nothing to query", () => {
  for (const name of ["nightly.yml", "nightly-proofs.yml", "nightly-host-proof.yml"]) {
    assert.doesNotMatch(readFileSync(resolve(root, ".github/workflows", name), "utf8"), /AXIOM/, `${name} reads no Axiom secret`);
  }
});

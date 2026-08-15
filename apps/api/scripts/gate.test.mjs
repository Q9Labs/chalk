import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "gate.sh");
const script = readFileSync(scriptPath, "utf8");

test("API gate command plan is Bash 3 compatible and keeps vet separate", () => {
  assert.doesNotMatch(script, /\bmapfile\b/);
  assert.doesNotMatch(script, /\bwait\s+-n\b/);
  assert.doesNotMatch(script, /rm -rf "\$\{lane_status_dir\}"/);
  assert.match(script, /go test -vet=off \.\/\.\.\.(?:\s|$)/);
  assert.match(script, /go test -race -vet=off \.\/\.\.\.(?:\s|$)/);
  assert.match(script, /go vet \.\/\.\.\.(?:\s|$)/);
  assert.match(script, /find "\$\{lane_status_dir\}" -depth -delete/);
});

test("API gate fails fast through lane cleanup", () => {
  assert.match(script, /start_lane "Database tests \+ lifecycle"/);
  assert.match(script, /start_lane "go vet"/);
  assert.match(script, /start_lane "Staticcheck"/);
  assert.match(script, /start_lane "Vulnerability check"/);
  assert.match(script, /if \[\[ "\$\{status\}" != "0" \]\]; then/);
  assert.match(script, /cleanup_lanes\n\s+exit "\$\{status\}"/);
  assert.match(script, /trap cleanup_lanes EXIT/);
});

test("API gate describes a deterministic local environment", () => {
  const result = spawnSync("bash", [scriptPath, "describe"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CHALK_API_ENV=local/);
  assert.match(result.stdout, /go test -vet=off \.\/\.\.\. and lifecycle smoke test in one lane/);
  assert.match(result.stdout, /go vet \.\/\.\.\., staticcheck, and govulncheck in parallel lanes/);
});

test("direct API gate provisions Postgres before running checks", () => {
  assert.match(script, /CHALK_GATE_POSTGRES_READY:-0/);
  assert.match(script, /exec .*scripts\/gates\/with-postgres\.sh/);
  assert.match(script, /go1\.25\.13\+auto/);
});

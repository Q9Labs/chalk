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
  assert.match(result.stdout, /PostgreSQL preparation and migrations overlap database-free checks/);
});

test("direct API gate overlaps Postgres preparation with database-free checks", () => {
  assert.match(script, /CHALK_GATE_POSTGRES_READY:-0/);
  assert.match(script, /with-postgres\.sh"[\s\\]+--api-gate-db-lane/);
  assert.match(script, /--database-lane/);
  assert.match(script, /go1\.25\.13\+auto/);

  const postgresStart = script.indexOf('start_lane "Database tests + lifecycle" run_postgres_gate');
  const inheritedDatabaseStart = script.indexOf('start_lane "Database tests + lifecycle" database_tests_and_lifecycle');
  const goVersion = script.indexOf('run "Go version" go version');
  assert.notEqual(postgresStart, -1);
  assert.notEqual(inheritedDatabaseStart, -1);
  assert.notEqual(goVersion, -1);
  assert.ok(postgresStart < goVersion, "Postgres preparation starts before database-free checks");
  assert.ok(inheritedDatabaseStart < goVersion, "inherited Postgres runs the database lane before static checks");
});

test("API database lane requires the ready wrapper callback", () => {
  assert.match(script, /command.*--database-lane/);
  assert.match(script, /CHALK_GATE_POSTGRES_READY:-0.*!= "1" \|\|/s);
  assert.match(script, /CHALK_GATE_POSTGRES_CALLBACK:-0.*!= "1"/);
  assert.match(script, /if \(\(internal_database_lane\)\); then[\s\S]*database_tests_and_lifecycle/);
});

test("direct API gate keeps race tests on the live database lane", () => {
  assert.match(script, /if \[\[ "\$\{CHALK_API_RACE:-0\}" == "1" \]\]; then[\s\S]*run_race_tests/);
  assert.match(script, /CHALK_API_RACE:-0.*direct_database_lane.*== "0"/);
});

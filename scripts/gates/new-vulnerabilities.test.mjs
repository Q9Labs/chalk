import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { govulncheckFindings, newFindings, osvFindings } from "./new-vulnerabilities.mjs";

const osvReport = (version) => ({
  results: [{ source: { path: "/repo/apps/api/go.mod" }, packages: [{ package: { name: "golang.org/x/text", version, ecosystem: "Go" }, vulnerabilities: [{ id: "GO-2021-0113" }] }] }],
});

// The shape of `govulncheck -format json`: pretty-printed objects, one after another.
const govulncheckStream = (version, frame) =>
  [{ config: { scanner_name: "govulncheck", scan_level: "symbol" } }, { finding: { osv: "GO-2021-0113", trace: [{ module: "golang.org/x/text", version }] } }, { finding: { osv: "GO-2021-0113", trace: [{ module: "golang.org/x/text", version, package: "golang.org/x/text/language", ...frame }] } }]
    .map((object) => JSON.stringify(object, null, 2))
    .join("\n");

test("a pull request fails only for the package versions it changes", () => {
  assert.deepEqual(newFindings(osvFindings(osvReport("0.3.5")), osvFindings(osvReport("0.3.5"))), []);
  assert.deepEqual(newFindings(osvFindings(osvReport("0.3.6")), osvFindings(osvReport("0.3.5"))), ["GO-2021-0113 Go golang.org/x/text@0.3.6"]);
  assert.deepEqual(newFindings(osvFindings(osvReport("0.3.5")), osvFindings({ results: [] })), ["GO-2021-0113 Go golang.org/x/text@0.3.5"]);
});

test("govulncheck counts only findings in called functions, as its text mode does", () => {
  assert.deepEqual([...govulncheckFindings(govulncheckStream("v0.3.5", {}))], []);
  const called = govulncheckFindings(govulncheckStream("v0.3.5", { function: "ParseAcceptLanguage" }));
  assert.deepEqual([...called], ["GO-2021-0113 golang.org/x/text@v0.3.5"]);
  assert.deepEqual(newFindings(called, called), []);
  assert.deepEqual(newFindings(called, govulncheckFindings(govulncheckStream("v0.3.5", {}))), ["GO-2021-0113 golang.org/x/text@v0.3.5"]);
});

test("the OSV scan reads the Sync mix.lock", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "chalk-osv-lockfiles-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["scripts/gates", "apps/sync", "bin"]) mkdirSync(path.join(root, directory), { recursive: true });
  copyFileSync(new URL("./osv-scanner.sh", import.meta.url), path.join(root, "scripts/gates/osv-scanner.sh"));
  writeFileSync(path.join(root, "apps/sync/mix.lock"), "%{}\n");
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(path.join(root, "bin/osv-scanner"), '#!/bin/bash\nprintf \'%s\\n\' "$@" > "$TEST_OSV_ARGS"\n', { mode: 0o755 });
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["add", "."], { cwd: root });
  const environment = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TEST_OSV_ARGS: path.join(root, "args.txt") };
  delete environment.GATE_VULN_BASE_REF;
  const result = spawnSync("bash", ["scripts/gates/osv-scanner.sh"], { cwd: root, encoding: "utf8", env: environment });
  assert.equal(result.status, 0, result.stderr);
  const lockfiles = readFileSync(path.join(root, "args.txt"), "utf8")
    .trim()
    .split("\n")
    .filter((_, index, args) => args[index - 1] === "--lockfile");
  assert.deepEqual(lockfiles.toSorted(), ["apps/sync/mix.lock", "pnpm-lock.yaml"]);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { dump, loadAll } from "js-yaml";
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
  symlinkSync(new URL("./zod-exception.mjs", import.meta.url), path.join(root, "scripts/gates/zod-exception.mjs"));
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

test("the OSV lane fails closed outside the locked Expo CLI zod exception", async (context) => {
  const source = readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8");
  const cases = [
    ["current lockfile", () => {}, true],
    [
      "direct production zod 3",
      (lock) => {
        lock.importers["apps/web"].dependencies.zod.version = "3.25.76";
      },
    ],
    [
      "direct zod in an allowed workspace",
      (lock) => {
        lock.importers["apps/mobile"].dependencies.zod = { version: "3.25.76" };
      },
    ],
    [
      "direct production zod 4",
      (lock) => {
        lock.importers["apps/web"].dependencies.zod.version = "4.6.5";
      },
    ],
    [
      "aliased optional zod",
      (lock) => {
        lock.importers["apps/web"].optionalDependencies = { validation: { version: "zod@3.25.76" } };
      },
    ],
    [
      "transitive runtime zod",
      (lock) => {
        lock.importers["apps/web"].dependencies.validation = { version: "1.0.0" };
        lock.snapshots["validation@1.0.0"] = { dependencies: { zod: "3.25.76" } };
      },
    ],
    [
      "direct Expo CLI consumer",
      (lock) => {
        const cli = Object.keys(lock.snapshots).find((key) => key.startsWith("@expo/cli@"));
        lock.importers["apps/web"].dependencies["@expo/cli"] = { version: cli.slice("@expo/cli@".length) };
      },
    ],
    [
      "another workspace reaches Expo through a link",
      (lock) => {
        lock.importers["apps/web"].dependencies.mobile = { version: "link:../mobile" };
      },
    ],
    [
      "a changed Expo CLI version",
      (lock) => {
        for (const [key, value] of Object.entries(lock.snapshots)) {
          if (!key.startsWith("@expo/cli@55.0.19")) continue;
          delete lock.snapshots[key];
          lock.snapshots[key.replace("@expo/cli@55.0.19", "@expo/cli@55.0.20")] = value;
        }
      },
    ],
  ];
  for (const [name, modify, passes = false] of cases) {
    await context.test(name, (subtest) => {
      const root = mkdtempSync(path.join(tmpdir(), "chalk-zod-exception-"));
      subtest.after(() => rmSync(root, { recursive: true, force: true }));
      mkdirSync(path.join(root, "bin"));
      // Resolve the guard's existing YAML dependency from the real script, not the fixture.
      symlinkSync(new URL("./zod-exception.mjs", import.meta.url), path.join(root, "zod-exception.mjs"));
      copyFileSync(new URL("./osv-scanner.sh", import.meta.url), path.join(root, "osv-scanner.sh"));
      const documents = loadAll(source);
      modify(documents.at(-1));
      writeFileSync(path.join(root, "pnpm-lock.yaml"), documents.map((document) => `---\n${dump(document)}`).join(""));
      writeFileSync(path.join(root, "bin/osv-scanner"), '#!/bin/bash\ntouch "$TEST_OSV_CALLED"\n', { mode: 0o755 });
      spawnSync("git", ["init", "-q"], { cwd: root });
      spawnSync("git", ["add", "pnpm-lock.yaml"], { cwd: root });
      const marker = path.join(root, "osv-called");
      const result = spawnSync("bash", ["osv-scanner.sh"], {
        cwd: root,
        encoding: "utf8",
        // The guard must run before the PR baseline can discount an existing finding.
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TEST_OSV_CALLED: marker, GATE_VULN_BASE_REF: "origin/master" },
      });
      assert.equal(result.status, passes ? 0 : 1, result.stderr);
      assert.equal(existsSync(marker), passes, "unsafe consumers must fail before OSV can ignore the advisory");
      if (!passes) assert.match(result.stderr, /Zod exception/);
    });
  }
});

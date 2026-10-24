import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("the zod importer guard fails closed outside the locked Expo CLI chain", async (context) => {
  const source = readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8");
  const cases = [
    ["current lockfile", () => {}, true],
    [
      "pnpm v6 transitive production zod",
      (_lock, documents) => {
        documents.splice(0, documents.length, {
          lockfileVersion: "6.0",
          importers: { ".": { dependencies: { "@expo/cli": { specifier: "55.0.19", version: "55.0.19" } } } },
          packages: { "/@expo/cli@55.0.19": { dependencies: { zod: "3.25.76" } }, "/zod@3.25.76": {} },
        });
      },
    ],
    [
      "unsupported version in the first YAML document",
      (_lock, documents) => {
        documents[0].lockfileVersion = "6.0";
      },
    ],
    [
      "missing pnpm lockfileVersion",
      (lock) => {
        delete lock.lockfileVersion;
      },
    ],
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
      // Resolve the guard's existing YAML dependency from the real script, not the fixture.
      symlinkSync(new URL("./zod-exception.mjs", import.meta.url), path.join(root, "zod-exception.mjs"));
      const documents = loadAll(source);
      modify(documents.at(-1), documents, root);
      writeFileSync(path.join(root, "pnpm-lock.yaml"), documents.map((document) => `---\n${dump(document)}`).join(""));
      const result = spawnSync("node", ["zod-exception.mjs", "pnpm-lock.yaml"], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(result.status, passes ? 0 : 1, result.stderr);
      if (!passes) {
        assert.match(result.stderr, /Zod exception/);
        if (name === "a changed Expo CLI version") {
          assert.match(result.stderr, /re-check.*Expo.*tooling/);
          assert.match(result.stderr, /allowed versions.*scripts\/gates\/zod-exception\.mjs/);
          assert.match(result.stderr, /exception.*osv-scanner\.toml/);
        }
      }
    });
  }
});

test("master OSV uses event.before exactly; new findings and daily findings stay red", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "chalk-osv-parent-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["scripts/gates", "bin"]) mkdirSync(path.join(root, directory), { recursive: true });
  for (const file of ["osv-scanner.sh", "new-vulnerabilities.mjs", "osv-snapshot.mjs", "zod-exception.mjs"]) copyFileSync(new URL(`./${file}`, import.meta.url), path.join(root, "scripts/gates", file));
  // The scanner fixture emits real OSV JSON from the scanned lockfile. The production
  // shell must scan both revisions and invoke the production comparer to pass.
  writeFileSync(
    path.join(root, "bin/osv-scanner"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const lock = require('node:path').join(args.at(-1), 'pnpm-lock.yaml');
const report = JSON.stringify({results:[{source:{path:lock,type:'lockfile'},packages:[{package:{name:'fixture', ecosystem:'npm', version:fs.readFileSync(lock,'utf8').match(/fixtureVersion: (.*)/)[1]}, vulnerabilities:[{id:'OSV-fixture'}]}]}]});
const output = args.indexOf('--output-file');
if (output >= 0) fs.writeFileSync(args[output + 1], report);
else console.log(report);
process.exit(Number(process.env.TEST_OSV_STATUS ?? 1));
`,
    { mode: 0o755 },
  );
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  symlinkSync(new URL("../../node_modules", import.meta.url), path.join(root, "node_modules"));
  writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  const commit = (version) => {
    writeFileSync(path.join(root, "pnpm-lock.yaml"), `lockfileVersion: "9.0"\nfixtureVersion: ${version}\n`);
    git("add", ".");
    git("commit", "-qm", version);
    return git("rev-parse", "HEAD");
  };
  const parent = commit("old");
  const before = commit("current");
  const scan = (baseline, extra = {}) =>
    spawnSync("bash", ["scripts/gates/osv-scanner.sh"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, GATE_VULN_BASE_REF: "", GATE_OSV_BASE_COMMIT: baseline, ...extra },
    });
  // Both revisions contain the same valid finding, so accepting scanner errors
  // would turn the master scan green and lose the original error in daily mode.
  for (const status of [2, 127, 255]) {
    for (const [mode, baseline] of [
      ["master push", before],
      ["daily", ""],
    ]) {
      await context.test(`${mode} propagates scanner error ${status} without pass output`, () => {
        const result = scan(baseline, { TEST_OSV_STATUS: String(status) });
        assert.equal(result.status, status, result.stdout + result.stderr);
        assert.doesNotMatch(result.stdout, /finding\(s\) also exist|^(?:New )?Finding:/mu, "scanner errors must not reach the findings comparer or report a pass");
      });
    }
  }
  assert.equal(scan(before).status, 0, "unchanged findings must use the comparer, not the scanner exit code");
  assert.equal(scan(parent).status, 1, "a newly vulnerable package version must fail");
  assert.equal(scan("").status, 1, "daily scans fail on every finding");
  assert.equal(scan("0".repeat(40)).status, 1, "branch creation has no baseline");
  assert.notEqual(scan("f".repeat(40)).status, 0, "unavailable force-push tip must fail closed");
  git("checkout", "-qb", "replacement", parent);
  commit("current");
  assert.equal(scan(before).status, 0, "force-push comparison must use before, not the common ancestor");
  git("checkout", "-qb", "merge-side");
  writeFileSync(path.join(root, "side.txt"), "side");
  git("add", ".");
  git("commit", "-qm", "side");
  git("checkout", "replacement");
  git("merge", "--no-ff", "-qm", "merge", "merge-side");
  assert.equal(scan(before).status, 0, "merge commits compare to the event's previous tip");
  assert.equal(scan("", { GATE_VULN_BASE_REF: parent }).status, 1, "PR comparison remains merge-base based");
});

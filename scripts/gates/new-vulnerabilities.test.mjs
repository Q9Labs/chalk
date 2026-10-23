import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

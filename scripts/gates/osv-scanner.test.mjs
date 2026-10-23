import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const integrity = "sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==";
const npm = JSON.stringify({ name: "runtime-app", lockfileVersion: 3, packages: { "": { dependencies: { zod: "3.25.76" } }, "node_modules/zod": { version: "3.25.76", integrity } } });
const yarn = `# yarn lockfile v1\n\nzod@3.25.76:\n  version "3.25.76"\n  resolved "https://registry.npmjs.org/zod/-/zod-3.25.76.tgz"\n  integrity ${integrity}\n`;
const bun = JSON.stringify({ lockfileVersion: 0, workspaces: { "": { name: "runtime-app", dependencies: { zod: "3.25.76" } } }, packages: { zod: ["zod@3.25.76", "", {}, integrity] } });
const pnpm = `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      zod:\n        specifier: 3.25.76\n        version: 3.25.76\npackages:\n  zod@3.25.76:\n    resolution: {integrity: ${integrity}}\nsnapshots:\n  zod@3.25.76: {}\n`;

// These tests deliberately require the real scanner, not a report or CLI mock.
test("OSV discovery enforces the tooling exception for every discovered format", { timeout: 240_000 }, async (context) => {
  const formats = [
    ["npm-shrinkwrap.json", npm],
    ["package-lock.json", npm],
    ["yarn.lock", yarn],
    ["bun.lock", bun],
  ];
  const cases = [
    ["current root lockfile", null, null],
    ...formats.flatMap(([file, content]) => [
      [file, file, content],
      [`nested/${file}`, `nested/${file}`, content],
    ]),
    ["nested/pnpm-lock.yaml", "nested/pnpm-lock.yaml", pnpm],
    ["tracked gitignored lockfile", "runtime/package-lock.json", npm],
    ["tracked symlinked lockfile", "runtime/package-lock.json", npm],
    ["ignored fixtures and excluded directories", null, null],
  ];
  for (const [name, file, content] of cases) {
    await context.test(name, (subtest) => {
      const temporary = mkdtempSync(path.join(tmpdir(), "chalk-osv-discovery-"));
      subtest.after(() => rmSync(temporary, { recursive: true, force: true }));
      const root = path.join(temporary, ".worktrees", "checkout");
      mkdirSync(root, { recursive: true });
      for (const script of ["osv-scanner.sh", "osv-snapshot.mjs", "zod-exception.mjs"]) symlinkSync(new URL(`./${script}`, import.meta.url), path.join(root, script));
      copyFileSync(new URL("./new-vulnerabilities.mjs", import.meta.url), path.join(root, "new-vulnerabilities.mjs"));
      copyFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), path.join(root, "pnpm-lock.yaml"));
      copyFileSync(new URL("../../osv-scanner.toml", import.meta.url), path.join(root, "osv-scanner.toml"));
      writeFileSync(path.join(root, ".gitignore"), name === "tracked gitignored lockfile" ? "runtime/\n" : "ignored-fixtures/\n");
      const git = (args) => {
        const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      };
      git(["init", "-q"]);
      if (file) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        if (name === "tracked symlinked lockfile") {
          writeFileSync(path.join(root, "runtime/dependency-data.json"), content);
          symlinkSync("dependency-data.json", path.join(root, file));
          git(["add", "runtime/dependency-data.json"]);
        } else writeFileSync(path.join(root, file), content);
        git(["add", "-f", file]);
      }
      if (name === "ignored fixtures and excluded directories") {
        for (const directory of ["ignored-fixtures", "node_modules/fixture", "nested/node_modules/fixture", ".git/fixture", ".worktrees/fixture", "nested/.worktrees/fixture"]) {
          mkdirSync(path.join(root, directory), { recursive: true });
          writeFileSync(path.join(root, directory, "npm-shrinkwrap.json"), npm);
        }
      }
      git(["add", "pnpm-lock.yaml", "osv-scanner.toml", ".gitignore"]);
      git(["-c", "user.name=OSV regression", "-c", "user.email=osv-regression@example.invalid", "commit", "-qm", "Fixture baseline"]);
      const result = spawnSync("bash", ["osv-scanner.sh"], { cwd: root, encoding: "utf8", env: { ...process.env, GATE_VULN_BASE_REF: "HEAD" }, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
      assert.equal(result.status, file ? 1 : 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
      if (file) assert.match(result.stderr, /Zod exception rejects OSV finding GHSA-mrhx-c7xc-m3w5/);
      else {
        assert.match(result.stdout, /Zod tooling exception accepted/);
        assert.doesNotMatch(result.stdout, /OSV input: .*?(?:ignored-fixtures|node_modules|\.git\/|\.worktrees)/);
      }
    });
  }
});

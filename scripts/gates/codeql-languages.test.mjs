import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { codeqlLanguages, languages } from "./codeql-languages.mjs";

const script = fileURLToPath(new URL("./codeql-languages.mjs", import.meta.url));
const run = (args, cwd) => execFileSync("node", [script, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("a pull request analyses only the languages whose files it changes", () => {
  assert.deepEqual(codeqlLanguages(["docs/managed-release.md", "apps/web/public/logo.png"]), []);
  assert.deepEqual(codeqlLanguages(["apps/web/src/app.tsx", "packages/ui/package.json"]), ["javascript-typescript"]);
  assert.deepEqual(codeqlLanguages(["apps/api/internal/rooms/rooms.go", "apps/api/go.sum"]), ["go"]);
  assert.deepEqual(codeqlLanguages(["scripts/releases/release.py"]), ["python"]);
  assert.deepEqual(codeqlLanguages([".github/workflows/gate.yml", ".github/actions/setup-scanners/action.yml"]), ["actions", "javascript-typescript"]);
  assert.deepEqual(codeqlLanguages(["infrastructure/nightly/host-cloud-init.yaml"]), ["javascript-typescript"]);
  assert.deepEqual(codeqlLanguages(["apps/mobile/android/app/src/main/AndroidManifest.xml"]), ["javascript-typescript"]);
  assert.deepEqual(codeqlLanguages(["apps/api/main.go", "scripts/gates/hygiene.mjs"]), ["go", "javascript-typescript"]);
});

test("a change to the CodeQL setup analyses every language", () => {
  assert.deepEqual(codeqlLanguages([".github/workflows/codeql.yml"]), languages);
  assert.deepEqual(codeqlLanguages(["scripts/gates/codeql-languages.mjs"]), languages);
  assert.deepEqual(codeqlLanguages([".github/codeql/codeql-config.yml"]), languages);
});

test("master pushes and a selection that cannot resolve its base analyse every language", () => {
  const all = `languages=${JSON.stringify(languages)}\n`;
  assert.equal(run(["--full"]), all);
  assert.equal(run(["origin/codeql-languages-missing-base"]), all);
});

test("changed files with non-ASCII or special characters in their names still select their language", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "chalk-codeql-languages-"));
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "master");
  git("commit", "-q", "--allow-empty", "-m", "base");
  const base = git("rev-parse", "HEAD");
  for (const [file, language] of [
    ["outside/café.go", "go"],
    ["outside/café.py", "python"],
    ['outside/quoted"name.mjs', "javascript-typescript"],
  ]) {
    git("switch", "-q", "--detach", base);
    mkdirSync(path.join(repo, "outside"), { recursive: true });
    writeFileSync(path.join(repo, file), "x\n");
    git("add", "--", file);
    git("commit", "-q", "-m", file);
    assert.equal(run([base], repo), `languages=${JSON.stringify([language])}\n`, file);
  }
});

test("only pull request runs share a concurrency group, so no master scan is replaced", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/codeql.yml", import.meta.url), "utf8");
  assert.match(workflow, /group: codeql-\$\{\{ github\.event_name == 'pull_request' && github\.ref \|\| github\.run_id \}\}/);
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { codeqlLanguages, languages } from "./codeql-languages.mjs";

const script = fileURLToPath(new URL("./codeql-languages.mjs", import.meta.url));
const run = (...args) => execFileSync("node", [script, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

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
  assert.equal(run("--full"), all);
  assert.equal(run("origin/codeql-languages-missing-base"), all);
});

test("only pull request runs share a concurrency group, so no master scan is replaced", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/codeql.yml", import.meta.url), "utf8");
  assert.match(workflow, /group: codeql-\$\{\{ github\.event_name == 'pull_request' && github\.ref \|\| github\.run_id \}\}/);
});

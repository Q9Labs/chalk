import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Built at runtime so this file holds no credential-shaped literal.
const leakedToken = ["ghp", "_", "R8x2Kq7Lm4Nv9Pz3Tb6Wc1Yd5Hf0Js8Ga2E"].join("");
const fixtureIdempotencyKey = ["disable", "fence", "0001"].join("-");
const genericKey = ["Rw8f2LqN0vXc", "4TzJ7hKp1sYd9mBaE3uG"].join("");
const refreshTest = "apps/api/internal/httpapi/access_grants_refresh_test.go";

const cases = [
  ...["apps/api/internal/httpapi/leak_test.go", "apps/web/src/leak.test.ts", "apps/web/src/leak.test.tsx", "apps/docs/src/content/docs/api/authentication.mdx"].map((file) => ({
    name: `a real token in ${file}`,
    file,
    line: `const token = "${leakedToken}";`,
  })),
  {
    name: "a real token on a line that also holds an allowlisted fixture key",
    file: "apps/api/internal/adapters/postgres/leak_test.go",
    line: `input := webhooks.PatchInput{IdempotencyKey: "${fixtureIdempotencyKey}", Secret: "${leakedToken}"}`,
  },
  {
    name: "a different key on the access-grant refresh fixture's line",
    file: refreshTest,
    // The whole real file, with the key on the line that master's history fingerprints by position.
    source: () => {
      const lines = readFileSync(new URL(`../../${refreshTest}`, import.meta.url), "utf8").split("\n");
      assert.match(lines[396], /^\ttoken\.Value = /u);
      lines[396] = `\ttoken.Value = "${genericKey}"`;
      return lines.join("\n");
    },
  },
];

for (const { name, file, line, source = () => `${line}\n` } of cases) {
  test(`the secret scan catches ${name}`, (context) => {
    const root = mkdtempSync(path.join(tmpdir(), "chalk-gitleaks-policy-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, "scripts/gates"), { recursive: true });
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    copyFileSync(new URL("./gitleaks.sh", import.meta.url), path.join(root, "scripts/gates/gitleaks.sh"));
    copyFileSync(new URL("../../.gitleaks.toml", import.meta.url), path.join(root, ".gitleaks.toml"));
    copyFileSync(new URL("../../.gitleaksignore", import.meta.url), path.join(root, ".gitleaksignore"));
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["-c", "user.name=Gate", "-c", "user.email=gate@example.invalid", "commit", "-q", "--allow-empty", "-m", "empty"], { cwd: root });
    writeFileSync(path.join(root, file), source());
    const result = spawnSync("bash", ["scripts/gates/gitleaks.sh"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GATE_EXPLICIT_FILES: file, GITLEAKS_LOG_OPTS: "-1 HEAD", GATE_SCOPE: "" },
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout + result.stderr, /leaks found: [1-9]/);
  });
}

test("every commit in this repository's history passes the secret scan", () => {
  const root = new URL("../..", import.meta.url).pathname;
  const result = spawnSync("bash", ["scripts/gates/gitleaks.sh"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITLEAKS_LOG_OPTS: "HEAD", GATE_SCOPE: "", GATE_EXPLICIT_FILES: "" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

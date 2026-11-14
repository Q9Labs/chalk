import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decide } from "./changed.mjs";

const featureMap = { features: [{ name: "mcp", paths: ["apps/api/internal/mcptools", "apps/api/internal/httpapi/mcp.go"] }] };

function repository(commits) {
  const cwd = mkdtempSync(join(tmpdir(), "mcp-changed-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  const shas = commits.map((files) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(cwd, file, ".."), { recursive: true });
      writeFileSync(join(cwd, file), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", "c");
    return git("rev-parse", "HEAD");
  });
  return { cwd, shas };
}

test("a release that changes MCP code, or code its check exercises, runs the check", () => {
  const { cwd, shas } = repository([{ "README.md": "a" }, { "apps/api/internal/mcptools/tool.go": "x" }, { "apps/api/internal/apikeys/key.go": "y" }]);
  try {
    assert.equal(decide({ previous: shas[0], target: shas[1], cwd, featureMap }).changed, true);
    assert.equal(decide({ previous: shas[1], target: shas[2], cwd, featureMap }).changed, true, "an API-key change");
    assert.match(decide({ previous: shas[0], target: shas[2], cwd, featureMap }).reason, /2 changed file\(s\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a release with no MCP change is skipped with a reason, and the diff spans every commit since the replaced release", () => {
  const { cwd, shas } = repository([{ "a.txt": "1" }, { "apps/api/internal/mcptools/tool.go": "x" }, { "b.txt": "2" }, { "c.txt": "3" }]);
  try {
    const skipped = decide({ previous: shas[2], target: shas[3], cwd, featureMap });
    assert.equal(skipped.changed, false);
    assert.match(skipped.reason, /^skipped: no change in MCP/);
    assert.equal(decide({ previous: shas[0], target: shas[3], cwd, featureMap }).changed, true, "an older replaced release sees the change in between");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an unknown previous release or a failed diff runs the check", () => {
  const { cwd, shas } = repository([{ "a.txt": "1" }, { "b.txt": "2" }]);
  try {
    assert.equal(decide({ previous: "", target: shas[1], cwd, featureMap }).changed, true);
    assert.match(decide({ previous: "0".repeat(40), target: shas[1], cwd, featureMap }).reason, /failed/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

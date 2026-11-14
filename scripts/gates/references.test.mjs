import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { brokenWorkflowReferences, uncalledScripts } from "./references.mjs";

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "references-"));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

test("a script that only a dead script or its own test names is uncalled", () => {
  const root = repo({
    "package.json": '{"scripts":{"build":"node scripts/live.mjs"}}',
    "scripts/live.mjs": 'import "./helper.mjs";',
    "scripts/helper.mjs": "",
    "scripts/orphan.mjs": 'import "./orphan-helper.mjs";',
    "scripts/orphan-helper.mjs": "",
    "scripts/lonely.mjs": "",
    "scripts/lonely.test.mjs": 'import "./lonely.mjs";',
  });
  try {
    assert.deepEqual(uncalledScripts(root).sort(), ["scripts/lonely.mjs", "scripts/orphan-helper.mjs", "scripts/orphan.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workflow path that does not exist and a missing root script are reported", () => {
  const root = repo({
    "package.json": '{"scripts":{"build":"true"}}',
    "scripts/real.mjs": "",
    ".github/workflows/ci.yml": ["jobs:", "  a:", "    steps:", "      - run: node scripts/real.mjs", "      - run: node scripts/gone.mjs", "      - run: pnpm run build && pnpm run missing", "      - run: ls scripts/${{ matrix.name }}.mjs"].join("\n"),
  });
  try {
    assert.deepEqual(brokenWorkflowReferences(root), [".github/workflows/ci.yml:5: scripts/gone.mjs does not exist", ".github/workflows/ci.yml:6: pnpm run missing is not a root package.json script"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

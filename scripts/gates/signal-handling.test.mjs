import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));

for (const scriptName of ["with-postgres.sh", "with-sync-topology.sh"]) {
  test(`${scriptName} exits with the received termination signal`, () => {
    const script = readFileSync(resolve(scriptsRoot, scriptName), "utf8");
    assert.match(script, /trap cleanup EXIT/);
    assert.match(script, /trap 'exit 130' INT/);
    assert.match(script, /trap 'exit 143' TERM/);
    assert.doesNotMatch(script, /trap cleanup EXIT INT TERM/);
  });
}

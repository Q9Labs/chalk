import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const here = import.meta.dirname;
const root = resolve(here, "../..");
// A proof bundles SDK source by path at run time, so a moved file fails only when a real-call proof reaches it.
const sdkFile = /(\.\.\/\.\.\/|\.\/|\$\{root\}\/)(sdks\/[\w./-]+\.(?:ts|tsx|mjs|json))/g;

test("every SDK source file a proof script bundles still exists", () => {
  const scripts = readdirSync(here).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"));
  const missing = [];
  let checked = 0;
  for (const script of scripts) {
    for (const [, , path] of readFileSync(resolve(here, script), "utf8").matchAll(sdkFile)) {
      checked++;
      if (!existsSync(resolve(root, path))) missing.push(`${script}: ${path}`);
    }
  }
  assert.ok(checked > 0, "the scan found no SDK paths, so it checks nothing");
  assert.deepEqual(missing, []);
});

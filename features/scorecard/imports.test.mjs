import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const importsOf = (file) => [...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/^import .* from "(.+)";$/gm)].map((match) => match[1]);

test("stats.mjs depends on nothing, so scripts outside the scorecard can import it", () => {
  assert.deepEqual(importsOf("./stats.mjs"), []);
});

test("the shared budget module does not know the web call check's devices and scenarios", () => {
  const forbidden = ["./call-budgets.mjs", "./metrics.mjs"];
  assert.deepEqual(
    importsOf("./budgets.mjs").filter((path) => forbidden.includes(path)),
    [],
  );
});

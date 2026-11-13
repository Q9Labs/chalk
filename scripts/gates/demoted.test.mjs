import assert from "node:assert/strict";
import test from "node:test";
import { demotedNotice, runDemoted } from "./demoted.mjs";

const entry = {
  id: "gate:example",
  demoted: { reason: "It fails under xvfb.", runs: ["43240593018", "43323563158"], issue: "https://github.com/Q9Labs/chalk/issues/1336" },
};

test("a demoted check that fails exits 0 and prints a warning that names the runs and the issue", () => {
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(line);
  try {
    assert.equal(runDemoted(entry, [process.execPath, "-e", "process.exit(3)"]), 0);
  } finally {
    console.log = log;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::warning title=Demoted check gate:example failed::/u);
  assert.match(lines[0], /43240593018 and 43323563158/u);
  assert.match(lines[0], /issues\/1336/u);
  assert.equal(demotedNotice(entry).includes("It fails under xvfb."), true);
});

test("a demoted check that passes prints nothing", () => {
  assert.equal(runDemoted(entry, [process.execPath, "-e", ""]), 0);
});

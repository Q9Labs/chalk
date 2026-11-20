// Run diagnose over observations captured from the disposable Sync and SDK processes.
// The capture is bounded by the harness, not evidence that production streams are complete.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { run } from "../diagnose.mjs";
import { CATALOGUE } from "../proof/catalogue.mjs";
import { completeWatermarks, observationsFromRows } from "../proof/rows.mjs";

const path = process.argv[2];
const capture = JSON.parse(readFileSync(path, "utf8"));
const { episode, tenant, from, to, seats, rows, fault } = capture;
const asof = to + 120_000;
const declaration = {
  kind: "episode",
  id: episode,
  tenant,
  features: ["board"],
  window: { from_ms: from, to_ms: to },
  seats: seats.map((participant) => ({
    participant,
    name: null,
    role: "participant",
    can_publish: true,
    generations: [1],
    connections: [],
    window: { from_ms: from, to_ms: to },
    person: { kind: "guest", device: null, name: null },
  })),
};
const checks = CATALOGUE.filter(({ code }) => code.startsWith("board.") && code !== "board.view_jumped");
const watermarks = completeWatermarks(declaration, checks, asof);
watermarks.push({ source: "report", subject: "*", complete_to_ms: asof, evidence_gaps: [], emits: ["report.problem"], build: "isolated proof with no report intake" });
const adapted = observationsFromRows(rows);
assert.deepEqual(adapted.dropped, []);
const evidence = { observations: adapted.observations, watermarks };
const world = {
  asof_ms: asof,
  declarations: [declaration],
  people: [],
  sessions: [],
  tenants: [{ id: tenant, name: "board proof", tz: "UTC" }],
  evidence: { [episode]: evidence },
  history: [{ item: episode, asof_ms: asof, evidence }],
};
const worldPath = `${path}.mjs`;
writeFileSync(worldPath, `export default () => (${JSON.stringify(world)});\n`);
const argv = [episode, "--fixture", worldPath, "--budget", "3000"];
const view = await run(argv);
assert.equal(view.code, 0, view.err);
console.log(`\n# ${fault}\n${view.out}`);
const findingLines = view.out.split("\n").filter((line) => /^f_/.test(line));
assert.ok(!findingLines.some((line) => /UNEXPLAINED|BLIND_SPOT|WITNESS_DISAGREEMENT/.test(line)), view.out);
const attribution = {
  "board.edit_not_committed": { index: 0, outcome: "broken", hop: "local_store" },
  "board.out_of_sync": { index: 1, outcome: "broken", hop: "replica" },
  "board.draw_denied": { index: 1, outcome: "expected", hop: "policy" },
  "board.snapshot_mismatch": { index: 2, outcome: "broken", hop: "snapshot" },
};
if (fault === "healthy") {
  assert.deepEqual(findingLines, []);
} else {
  const { index, outcome, hop } = attribution[fault];
  const scope = seats[index].replaceAll("-", "").slice(0, 4);
  assert.ok(
    findingLines.some((line) => line.includes(` ${outcome} ${fault} pt_${scope}`) && line.includes(`hop=${hop} module=sdk.whiteboard`)),
    view.out,
  );
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkCoverage } from "./obs-coverage.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const graph = JSON.parse(readFileSync(join(root, "observability/generated/coverage-graph.json"), "utf8"));
const example = graph.symptoms.find((symptom) => symptom.code === "end.wrong_screen");
const only = (symptom) => ({ symptoms: [symptom] });

test("the worked example is covered end to end and every other symptom is allow-listed", async () => {
  const result = await checkCoverage({ root, graph });
  assert.deepEqual(result.failures, []);
  assert.ok(result.covered.includes("end.wrong_screen"));
  assert.equal(result.allowlisted.length, graph.symptoms.length - result.covered.length);
  for (const entry of result.allowlisted) assert.ok(entry.missing.length > 0, `${entry.code} lists no missing link`);
});

test("a symptom without a fault scenario fails", async () => {
  const { failures } = await checkCoverage({ root, graph: only({ ...example, fault_scenario: null }) });
  assert.match(failures.join("\n"), /end\.wrong_screen is missing: a fault scenario/u);
});

test("an emit site that no longer contains its literal fails", async () => {
  const events = example.events.map((event) => ({ ...event, emit_sites: event.emit_sites.map((site) => ({ ...site, literal: "no-such-literal" })) }));
  const { failures } = await checkCoverage({ root, graph: only({ ...example, events }) });
  assert.match(failures.join("\n"), /no longer contains no-such-literal/u);
});

test("a healthy fixture the rule flags, or a positive one it misses, fails", async () => {
  const swapped = { ...example, fixtures: { positive: example.fixtures.healthy, healthy: example.fixtures.positive } };
  const { failures } = await checkCoverage({ root, graph: only(swapped) });
  assert.match(failures.join("\n"), /positive fixture .* gives no end\.wrong_screen finding/u);
  assert.match(failures.join("\n"), /healthy fixture .* gives 1 end\.wrong_screen finding/u);
});

test("a positive fixture with no row of a witnessing event fails", async () => {
  const witnesses = example.witnesses.map((witness) => (witness.fact === "end.client_screen" ? { ...witness, events: witness.events.map((event) => ({ ...event, event: "client.screen_shown" })) } : witness));
  const { failures } = await checkCoverage({ root, graph: only({ ...example, witnesses }) });
  assert.match(failures.join("\n"), /positive fixture has no client\.screen_shown row for end\.client_screen/u);
});

test("an allow-listed symptom that is complete fails, so the list only shrinks", async () => {
  const { failures } = await checkCoverage({ root, graph: only({ ...example, allowlisted: true }) });
  assert.match(failures.join("\n"), /end\.wrong_screen is complete: remove it/u);
});

test("an incomplete symptom that is not allow-listed fails", async () => {
  const stub = graph.symptoms.find((symptom) => symptom.allowlisted);
  const { failures } = await checkCoverage({ root, graph: only({ ...stub, allowlisted: false }) });
  assert.match(failures.join("\n"), new RegExp(`${stub.code.replace(".", "\\.")} is missing: witnesses`, "u"));
});

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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

test("a fault scenario that only names the symptom and the chain, and skips its test, fails because it is not the chain's first hop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-coverage-"));
  writeFileSync(join(dir, "fake.fault.test.ts"), '// end.wrong_screen\n// observability/fixtures/end.wrong_screen/chain/\nit.skip("never runs", () => {});\n');
  const { failures } = await checkCoverage({ root, graph: only({ ...example, fault_scenario: relative(root, join(dir, "fake.fault.test.ts")) }) });
  assert.match(failures.join("\n"), /the first hop in observability\/fixtures\/end\.wrong_screen\/chain\/hops\.json must be the fault scenario/u);
});

/** A copy of the repository whose observability tree is its own, so a test can add a file to a chain. */
function rootWithChainFile(name, text) {
  const copy = mkdtempSync(join(tmpdir(), "obs-coverage-root-"));
  for (const entry of readdirSync(root)) if (entry !== "observability") symlinkSync(join(root, entry), join(copy, entry));
  cpSync(join(root, "observability"), join(copy, "observability"), { recursive: true });
  writeFileSync(join(copy, "observability/fixtures/end.wrong_screen/chain", name), text);
  return copy;
}

test("a chain file no declared hop writes fails, so a hand-written hand-off can't join the chain", async () => {
  const rows = readFileSync(join(root, "observability/fixtures/end.wrong_screen/chain/api-rows.positive.json"), "utf8");
  const { failures } = await checkCoverage({ root: rootWithChainFile("handwritten.positive.json", rows), graph: only(example) });
  assert.match(failures.join("\n"), /chain file handwritten\.positive\.json is written by no hop/u);
});

test("a fixture whose rows are not its chain's rows fails, so a hop that renames a field cannot hide behind a hand-written fixture", async () => {
  const positive = JSON.parse(readFileSync(join(root, example.fixtures.positive), "utf8"));
  const edited = { ...positive, rows: positive.rows.map((row) => ({ ...row, est_server_ms: row.est_server_ms + 1 })) };
  const unchained = { ...positive, chain: undefined };
  const dir = mkdtempSync(join(tmpdir(), "obs-coverage-"));
  writeFileSync(join(dir, "edited.json"), JSON.stringify(edited));
  writeFileSync(join(dir, "unchained.json"), JSON.stringify(unchained));
  const at = (name) => relative(root, join(dir, name));
  const failuresFor = async (name) => (await checkCoverage({ root, graph: only({ ...example, fixtures: { ...example.fixtures, positive: at(name) } }) })).failures.join("\n");
  assert.match(await failuresFor("edited.json"), /positive fixture rows are not the rows of its chain files/u);
  assert.match(await failuresFor("unchained.json"), /positive fixture names no chain hand-off files/u);
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

// @ts-check
// fallow-ignore-file complexity -- each branch is a case of this test; the CRAP estimate reads a test's own branches as untested.
/**
 * Slice 13's fixture builder and chain end: each symptom's hand-off rows — the client kernel's frames where the client
 * owns records, the API's kernel rows on real Postgres, the Postgres snapshot as db-source rows, and Sync's delivery
 * rows — become the positive and healthy fixtures, then the real rule judges them. The expected hop is the spec's: the
 * check names where the evidence broke, not where it was healthy.
 *
 * `node --test scripts/diagnose-call/proof/report-live-chain.test.mjs` writes nothing; with `CHALK_CHAIN_WRITE=1` it
 * rewrites the fixtures. `--scenario <code>` limits it to one symptom (the chain's replay mode).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CATALOGUE, RULES } from "./catalogue.mjs";
import { FACTS } from "./facts.mjs";
import { eventOf, judgeFixture, ruleResult } from "./rows.mjs";

/** @typedef {import("./rows.mjs").Fixture} Fixture */
/** @typedef {import("./rows.mjs").Row} Row */
/** @typedef {import("./profile.mjs").Declaration} Declaration */

const root = new URL("../../../", import.meta.url);
/** @param {string} path */
const read = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const argv = process.argv;
const only = argv.includes("--scenario") ? argv[argv.indexOf("--scenario") + 1] : null;

const EPISODE = "1f8fad5b-d9cb-469f-a165-70867728950e";
const TENANT = "c1000000-0000-4000-8000-000000000001";
const SEAT = "a1000000-0000-4000-8000-000000000001";
const WINDOW = { from_ms: 1_795_596_400_000, to_ms: 1_795_600_000_000 };
const ASOF = 1_795_600_300_000;

/**
 * What one symptom's chain proves: the hop its positive run expects. `seat_left_ms` marks a seat that left before the
 * report surface showed (report.cannot_send's subject window ends at the seat's leave).
 */
const SCENARIOS = {
  "report.cannot_send": { hop: "client_ui", seat_left_ms: 1_795_600_000_000 },
  "report.send_failed": { hop: "api" },
  "report.forward_failed": { hop: "api_forward" },
  "report.upload_missing": { hop: "client_upload" },
  "live.target_unreachable": { hop: "sync_socket" },
  "live.no_reply": { hop: "client_handler" },
  "live.upload_missing": { hop: "client_upload" },
};

/** @param {{ seat_left_ms?: number }} [options] @returns {Declaration} */
const declarationOf = ({ seat_left_ms } = {}) => ({
  kind: "episode",
  id: EPISODE,
  tenant: TENANT,
  features: [],
  window: WINDOW,
  seats: [
    {
      participant: SEAT,
      name: "Seat A",
      role: "participant",
      can_publish: true,
      generations: [1],
      connections: [],
      window: { from_ms: WINDOW.from_ms, to_ms: seat_left_ms ?? WINDOW.to_ms },
      person: { kind: "user", id: "b1000000-0000-4000-8000-000000000001", name: "Seat A" },
    },
  ],
});

/**
 * The chain files one run's fixture is built from, in hop order. Missing files just don't contribute — the symptoms
 * that own no client or sync hop write none.
 * @param {string} code @param {"positive" | "healthy"} run
 */
const chainFiles = (code, run) =>
  [`client-frames.${code}.${run}.json`, `api-rows.${code}.${run}.json`, `db-rows.${code}.${run}.json`, `sync-rows.${code}.${run}.json`]
    .map((name) => `observability/fixtures/${code}/chain/${name}`)
    .filter((path) => existsSync(new URL(path, root)));

/**
 * The fixture a run's hand-off rows make. `client-frames` files hold `[{ events: [...] }]`; the rest hold `[row]`.
 * @param {string} code @param {"positive" | "healthy"} run
 * @returns {Fixture & { chain: string[] }}
 */
function chainFixture(code, run) {
  const chain = chainFiles(code, run);
  assert.notEqual(chain.length, 0, `no chain files for ${code} ${run}: run the chain in order first`);
  /** @type {Row[]} */
  const rows = chain.flatMap((path) => {
    const data = read(path);
    return data.length > 0 && Array.isArray(data[0]?.events) ? data.flatMap((frame) => frame.events) : data;
  });
  const scenario = SCENARIOS[/** @type {keyof typeof SCENARIOS} */ (code)];
  return {
    description: `${code} ${run}: the ${run === "positive" ? "fault" : "control"} run's rows as the chain's hops wrote them. Expected hop: ${scenario.hop}.`,
    asof_ms: ASOF,
    declaration: declarationOf(scenario),
    chain,
    rows,
  };
}

/**
 * Rewrites the fixture in write mode, else checks the committed file is what the chain would write.
 * @param {string} code @param {"positive" | "healthy"} run
 */
function handOff(code, run) {
  const fixture = chainFixture(code, run);
  const path = `observability/fixtures/${code}/${run}.json`;
  const text = `${JSON.stringify(fixture, null, 2)}\n`;
  if (process.env.CHALK_CHAIN_WRITE === "1") writeFileSync(new URL(path, root), text);
  assert.deepEqual(read(path), JSON.parse(text), `${path} is not the chain's rows: run the chain in order with CHALK_CHAIN_WRITE=1`);
  return fixture;
}

/** Required fields each fact event declares, so the assert below can demand them on every row while optional fields stay
 * legitimately absent (a delivered request has no unavailable_reason). */
const REQUIRED_FIELDS = Object.freeze(Object.fromEntries(
  read("observability/generated/registry.json").events.map((/** @type {{ name: string, fields: Record<string, { required?: boolean }>}} */ event) => [
    event.name,
    Object.freeze(Object.entries(event.fields).filter(([, spec]) => spec.required === true).map(([name]) => name)),
  ]),
));

/** Every required field of a report/live fact's event is on every one of its rows, so no hop renamed or dropped one.
 * @param {Fixture} fixture */
function assertFactFields(fixture) {
  for (const [fact, def] of Object.entries(FACTS).filter(([name]) => name.startsWith("report.") || name.startsWith("live."))) {
    for (const event of def.events) {
      const rows = fixture.rows.filter((row) => eventOf(row) === event.event);
      const required = REQUIRED_FIELDS[event.event] ?? [];
      for (const row of rows) for (const field of required) assert.ok(field in row, `${event.event} row has no ${field}, which ${fact} requires`);
    }
  }
}

const codes = only === null ? Object.keys(SCENARIOS) : [only];
for (const code of codes) {
  const scenario = SCENARIOS[/** @type {keyof typeof SCENARIOS} */ (code)];
  assert.ok(scenario, `no scenario ${code}`);
  describe(`${code}'s chain ends in the kernel's verdict`, () => {
    it(`positive: the chain's rows give the finding on ${scenario.hop}`, () => {
      const fixture = handOff(code, "positive");
      assertFactFields(fixture);
      const { verdict, dropped } = judgeFixture(fixture, CATALOGUE, code);
      assert.deepEqual(dropped, []);
      const [finding] = verdict.findings.filter((entry) => entry.code === code);
      assert.equal(finding?.hop, scenario.hop, JSON.stringify(verdict.findings, null, 2));
    });
    it("healthy: the chain's rows check the seat and give no finding", () => {
      const fixture = handOff(code, "healthy");
      assertFactFields(fixture);
      const { verdict, dropped } = judgeFixture(fixture, CATALOGUE, code);
      assert.deepEqual(dropped, []);
      assert.deepEqual(ruleResult(verdict, code), { findings: 0, checked: 1, eligible: 1 }, JSON.stringify(verdict.coverage.gaps.filter((gap) => gap.kind === "check" && gap.code === code)));
    });
  });
}

// @ts-check
// fallow-ignore-file complexity -- each branch is a case of this test; the CRAP estimate reads a test's own branches as untested.
// Hop (d) of the end.wrong_screen chain (observability/fixtures/end.wrong_screen/README.md): the rows the API logged for the
// client's frames (hop b) and the row Sync logged for the Episode's end (hop c) become the symptom's positive and healthy fixtures
// unchanged, and the kernel judges them through the row adapter. The positive run gives the finding; the healthy control checks
// every eligible seat and gives none. The same rows, with the ledger report hop (b) handed off, also go through the live reader
// (live/world.mjs) the way `diagnose --live` reads them from Axiom. CHALK_CHAIN_WRITE=1 rewrites the fixtures.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SERVICES, liveWorld } from "../live/world.mjs";
import { CATALOGUE, RULES } from "./catalogue.mjs";
import { check } from "./check.mjs";
import { origin } from "./evidence.mjs";
import { FACTS } from "./facts.mjs";
import { openWorld } from "./fixture-world.mjs";
import { eventOf, judgeFixture, ruleResult } from "./rows.mjs";

/** @typedef {import("./rows.mjs").Fixture} Fixture */
/** @typedef {import("./rows.mjs").Row} Row */

const CODE = "end.wrong_screen";
const FIXTURES = `observability/fixtures/${CODE}`;
const root = new URL("../../../", import.meta.url);
/** @param {string} path */
const read = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

const EPISODE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const TENANT = "c1000000-0000-4000-8000-000000000001";
const SEAT = "a1000000-0000-4000-8000-000000000001";
const WINDOW = { from_ms: 1_795_596_400_000, to_ms: 1_795_600_000_000 };

/** The Episode the chain's API hop credentialed its seat for, with that one seat. @type {import("./profile.mjs").Declaration} */
const DECLARATION = {
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
      window: WINDOW,
      person: { kind: "user", id: "b1000000-0000-4000-8000-000000000001", name: "Seat A" },
    },
  ],
};

/** @type {{ readonly [run in "positive" | "healthy"]: string }} */
const DESCRIPTIONS = {
  positive:
    "The Episode hit its maximum duration. The seat's client lost the end notice, read a stale active status after its media credential was revoked, and showed connection lost 1.2 s after the end. Sync's row and the client's row are the ones the chain's hops logged, so the seat is checked and the finding is broken.",
  healthy: "The Episode hit its maximum duration. The seat's client read the ended status after its media credential was revoked and showed the Episode-ended screen 0.3 s after the end. The rows are the ones the chain's hops logged, so the seat is checked and passes.",
};

/**
 * The fixture a run's hand-off rows make: Sync's end row, then the API's rows, as each hop wrote them.
 * @param {"positive" | "healthy"} run
 * @returns {Fixture & { chain: string[] }}
 */
function chainFixture(run) {
  const chain = [`${FIXTURES}/chain/sync-rows.json`, `${FIXTURES}/chain/api-rows.${run}.json`];
  /** @type {Row[]} */
  const rows = chain.flatMap((path) => read(path));
  return { description: DESCRIPTIONS[run], asof_ms: 1_795_600_300_000, declaration: DECLARATION, chain, rows };
}

/** @param {"positive" | "healthy"} run */
function handOff(run) {
  const fixture = chainFixture(run);
  const path = `${FIXTURES}/${run}.json`;
  const text = `${JSON.stringify(fixture, null, 2)}\n`;
  if (process.env.CHALK_CHAIN_WRITE === "1") writeFileSync(new URL(path, root), text);
  assert.deepEqual(read(path), JSON.parse(text), `${path} is not the chain's rows: run the chain in order with CHALK_CHAIN_WRITE=1`);
  return fixture;
}

/** Every field a fact reads from its event is on that event's rows under the registry's name, so no hop renamed one. @param {Fixture} fixture */
function assertFactFields(fixture) {
  for (const [fact, def] of Object.entries(FACTS).filter(([name]) => name.startsWith("end."))) {
    for (const event of def.events) {
      const rows = fixture.rows.filter((row) => eventOf(row) === event.event);
      assert.notEqual(rows.length, 0, `no ${event.event} row for ${fact}`);
      for (const row of rows) for (const field of event.fields) assert.ok(field in row, `${event.event} row has no ${field}, which ${fact} reads`);
    }
  }
}

const iso = (/** @type {number} */ at) => new Date(at).toISOString();

/** The Episode as Postgres declares it to the live reader: the same seat, ended at its maximum duration. @type {import("../live/world.mjs").DbEpisode} */
const DB = {
  episode: { id: EPISODE, tenant: TENANT, space: "d1000000-0000-4000-8000-000000000001", created_at: iso(WINDOW.from_ms), started_at: iso(WINDOW.from_ms), ended_at: iso(WINDOW.to_ms), end_reason: "maximum_duration" },
  tenant: { id: TENANT, name: "Chain" },
  seats: [
    {
      participant: SEAT,
      name: "Seat A",
      role: "participant",
      capabilities: ["publishAudio"],
      generation: 1,
      connection: null,
      created_at: iso(WINDOW.from_ms),
      joined_at: iso(WINDOW.from_ms),
      left_at: iso(WINDOW.to_ms),
      account: null,
      identity: { id: "b1000000-0000-4000-8000-000000000001", kind: "user", name: "Seat A" },
    },
  ],
};

/**
 * A run's chain read the live way: each hand-off row as Axiom returns it (fields under `attributes`, the service that logged it),
 * the ledger report hop (b) handed off, and the verdict `check` gives on the World the live reader builds.
 * @param {"positive" | "healthy"} run
 */
async function liveVerdict(run) {
  const service = (/** @type {string} */ path) => (path.includes("sync-rows") ? SERVICES.sync : SERVICES.api);
  const fixture = chainFixture(run);
  const rows = fixture.chain.flatMap((path) => read(path).map((/** @type {Row} */ attributes) => ({ attributes, service: { name: service(path) } })));
  const { world } = liveWorld({ db: DB, ledger: read(`${FIXTURES}/chain/ledger.${run}.json`), rows, asof_ms: fixture.asof_ms });
  const { ports } = await openWorld(world, { catalogue: CATALOGUE, rules: RULES });
  const [checked] = await check({ item: { kind: "episode", id: EPISODE } }, ports, { catalogue: CATALOGUE, rules: RULES, asof_ms: fixture.asof_ms });
  assert.ok(checked);
  return { world, verdict: checked.verdict };
}

/** The client session the client's kernel stamped on its end record, as hop (a) handed it off. @param {"positive" | "healthy"} run */
const frameSession = (run) => {
  const records = read(`${FIXTURES}/chain/client-frames.${run}.json`).flatMap((/** @type {{ events: Row[] }} */ frame) => frame.events);
  const sessions = [...new Set(records.filter((record) => record.name === "client.call_ended").map((record) => record.client_session_id))];
  assert.equal(sessions.length, 1);
  return /** @type {string} */ (sessions[0]);
};

describe("end.wrong_screen's chain ends in the kernel's verdict", () => {
  it("positive: the chain's rows give the finding on the client's end hop", () => {
    const fixture = handOff("positive");
    assertFactFields(fixture);
    const { verdict, dropped } = judgeFixture(fixture, CATALOGUE, CODE);
    assert.deepEqual(dropped, []);
    assert.equal(ruleResult(verdict, CODE).findings, 1);
    const [finding] = verdict.findings.filter((entry) => entry.code === CODE);
    assert.equal(finding?.hop, "client_end");
    assert.equal(finding?.observed, "the Episode ended (maximum_duration) and the client showed connection_lost");
  });

  it("healthy: the chain's rows check the seat and give no finding", () => {
    const fixture = handOff("healthy");
    assertFactFields(fixture);
    const { verdict, dropped } = judgeFixture(fixture, CATALOGUE, CODE);
    assert.deepEqual(dropped, []);
    assert.deepEqual(ruleResult(verdict, CODE), { findings: 0, checked: 1, eligible: 1 });
  });

  it("live: the positive chain gives the finding through the live reader, from the client session the frames carry", async () => {
    const { world, verdict } = await liveVerdict("positive");
    const [finding] = verdict.findings.filter((entry) => entry.code === CODE);
    assert.equal(finding?.hop, "client_end");
    const session = frameSession("positive");
    const screen = world.evidence[EPISODE]?.observations.filter((observation) => observation.fact === "end.client_screen") ?? [];
    assert.deepEqual(
      screen.map((observation) => [observation.origin, observation.subject.attempt]),
      [[origin.measured("client", session), session]],
    );
    assert.deepEqual(world.sessions, [{ id: session, meaning: "client_session", episode: EPISODE, participant: SEAT }]);
  });

  it("live: the healthy chain stays unchecked, because Sync has no delivery ledger and the ledger misses the client's earlier records", async () => {
    const { verdict } = await liveVerdict("healthy");
    assert.notEqual(verdict.outcome, "healthy");
    assert.deepEqual(ruleResult(verdict, CODE), { findings: 0, checked: 0, eligible: 1 });
  });
});

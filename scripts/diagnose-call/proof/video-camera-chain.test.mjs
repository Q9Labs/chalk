// @ts-check
// Hop (b) of the camera chain: stamps the client hop's wire rows into the rows a Postgres ledger
// stores (participant, Episode and clock stamps are pinned; the row's own fields are unchanged), then
// judges the symptom's rule the way the coverage gate does. CHALK_CHAIN_WRITE=1 rewrites the files.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { judgeFixture, ruleResult } from "./rows.mjs";
import { CATALOGUE } from "./catalogue.mjs";

/** @typedef {import("./rows.mjs").Fixture} Fixture */
/** @typedef {import("./rows.mjs").Row} Row */

const root = new URL("../../../", import.meta.url);
const read = (/** @type {string} */ path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

const EPISODE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const TENANT = "c1000000-0000-4000-8000-000000000001";
const SPACE = "d1000000-0000-4000-8000-000000000001";
const SEAT = "a1000000-0000-4000-8000-000000000001";
const SOURCE = "e1000000-0000-4000-8000-000000000001";
const WINDOW = { from_ms: 1_795_599_000_000, to_ms: 1_795_601_000_000 };

/** @type {import("./profile.mjs").Declaration} */
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

/** One wire event as the ledger stores it: the seat and Episode it was credentialed for, and the synced clock stamps. */
function stored(/** @type {Record<string, unknown>} */ row) {
  const wall = typeof row.client_wall_ms === "number" ? row.client_wall_ms : WINDOW.from_ms;
  return {
    clock_state: "synced",
    env: "test",
    episode_id: EPISODE,
    est_server_ms: wall,
    generation: 1,
    participant_id: SEAT,
    source_id: SOURCE,
    space_id: SPACE,
    tenant_id: TENANT,
    ...row,
    est_server_ms: wall,
  };
}

const CHAIN = (/** @type {string} */ code) => `observability/fixtures/${code}/chain`;

/** Reads one run's hand-off rows for a symptom, stamping wire rows into stored rows. */
function rowsFor(/** @type {string} */ code, /** @type {string} */ run) {
  const path = `${CHAIN(code)}/client-frames.${run}.json`;
  const stamped = read(path).map(stored);
  const out = `${CHAIN(code)}/rows.${run}.json`;
  if (process.env.CHALK_CHAIN_WRITE === "1") writeFileSync(new URL(out, root), `${JSON.stringify(stamped, null, 2)}\n`);
  assert.deepEqual(read(out), stamped, `${out} is stale: rerun hop (a), then this hop with CHALK_CHAIN_WRITE=1`);
  return { path: out, rows: stamped };
}

/** The Sync hop's stored rows: intent and Episode end, already in ledger shape. */
function syncRows(/** @type {string} */ code) {
  const path = `${CHAIN(code)}/sync-rows.json`;
  return { path, rows: read(path) };
}

/** Builds or verifies a symptom's fixture from its stamped chain rows plus the Sync hop's rows. */
function fixture(/** @type {string} */ code, /** @type {"positive" | "healthy"} */ kind, /** @type {string} */ run, /** @type {string} */ description) {
  const client = rowsFor(code, run);
  const sync = syncRows(code);
  const fixture = { description, asof_ms: WINDOW.to_ms, declaration: DECLARATION, chain: [client.path, sync.path], rows: [...client.rows, ...sync.rows] };
  const file = `observability/fixtures/${code}/${kind}.json`;
  const text = `${JSON.stringify(fixture, null, 2)}\n`;
  if (process.env.CHALK_CHAIN_WRITE === "1") writeFileSync(new URL(file, root), text);
  assert.deepEqual(read(file), JSON.parse(text), `${file} is stale: rerun this hop with CHALK_CHAIN_WRITE=1`);
  return fixture;
}

describe("video camera chain, hop (b)", () => {
  for (const [code, run, kind, description] of /** @type {const} */ ([
    ["video.camera_wont_start", "wont_start", "positive", "The seat's camera capture failed with NotFoundError: the op ended error(video.device_not_found), the machine reached ended and never live+bound. The rows are the chain's client hop's."],
    ["video.camera_wont_start", "healthy", "healthy", "The seat's camera captured, went live and bound, and only ended when the seat left. The rows are the chain's client hop's."],
    ["video.camera_stopped", "stopped", "positive", "The seat's live, bound camera ended with trigger track_ended and stayed down with no deliberate cause. The rows are the chain's client hop's."],
    ["video.camera_stopped", "healthy", "healthy", "The seat's live, bound camera ended only with the deliberate leave-path triggers. The rows are the chain's client hop's."],
  ])) {
    it(`${code} ${kind}: the rule and the chain agree`, () => {
      const judged = judgeFixture(fixture(code, kind, run, description), CATALOGUE, code);
      assert.equal(judged.dropped.length, 0, JSON.stringify(judged.dropped));
      const result = ruleResult(judged.verdict, code);
      if (kind === "positive") assert.equal(result.findings, 1, JSON.stringify(judged.verdict.findings));
      else assert.deepEqual(result, { findings: 0, checked: 1, eligible: 1 }, JSON.stringify(judged.verdict));
    });
  }
});

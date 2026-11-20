// @ts-check
// The live World over synthetic stores: seq gaps placed in time by the source's own rows, a seat with an open gap left unchecked,
// a closed source with no gaps complete, and `diagnose --live` opening it. Every id and row here is made up.
import assert from "node:assert/strict";
import test from "node:test";
import { run } from "../diagnose.mjs";
import { uncovered } from "../proof/evidence.mjs";
import { StoreError, psqlFailure, realStores } from "./stores.mjs";
import { clientWatermark, liveWorld, sourceCoverage, unwrapRow } from "./world.mjs";

/** @typedef {import("./world.mjs").LedgerSource} LedgerSource */
/** @typedef {import("./stores.mjs").Stores} Stores */

const TENANT = "0e000000-0000-4000-8000-000000000001";
const EPISODE = "0e000000-0000-4000-8000-000000000002";
const CLOSED_SEAT = "0e000000-0000-4000-8000-0000000000a1";
const OPEN_SEAT = "0e000000-0000-4000-8000-0000000000b2";
const QUIET_SEAT = "0e000000-0000-4000-8000-0000000000c3";
const CLOSED_SOURCE = "0e000000-0000-4000-8000-0000000000d4";
const OPEN_SOURCE = "0e000000-0000-4000-8000-0000000000e5";

const START = Date.parse("2026-01-05T10:00:00Z");
const END = START + 30 * 60_000;
const NOW = END + 10 * 60_000;
const iso = (/** @type {number} */ at) => new Date(at).toISOString();

/** @type {LedgerSource} */
const closed = { source_id: CLOSED_SOURCE, watermark: { participants: [CLOSED_SEAT], next_seq: 3, end: "closed", stored: [{ from: 0, to: 3 }] }, gaps: [] };
/** @type {LedgerSource} */
const open = {
  source_id: OPEN_SOURCE,
  watermark: { participants: [OPEN_SEAT], next_seq: 3, end: null, stored: [{ from: 0, to: 1 }, { from: 2, to: 3 }] },
  gaps: [
    { source_id: OPEN_SOURCE, from_seq: 1, to_seq: 2, cause: "missing", status: "open" },
    { source_id: OPEN_SOURCE, from_seq: 3, to_seq: null, cause: "tail_unknown", status: "open" },
  ],
};

let rowId = 0;
/** An Axiom answer row: event fields under `attributes`, the service under `service.name`. */
const axiomRow = (/** @type {number} */ at, /** @type {string} */ service, /** @type {Record<string, unknown>} */ attributes) => ({ _time: iso(at), _rowId: `r${(rowId += 1)}`, service: { name: service }, attributes: { episode_id: EPISODE, est_server_ms: at, ...attributes } });
const clientRow = (/** @type {string} */ source, /** @type {string} */ participant, /** @type {number} */ seq, /** @type {number} */ at, extra = {}) =>
  axiomRow(at, "chalk-api", { event: "client.heartbeat", event_id: `0e0000ee-0000-4000-8000-${String(seq).padStart(4, "0")}${source.slice(-8)}`, source_id: source, seq, participant_id: participant, ...extra });

const ROWS = [
  clientRow(CLOSED_SOURCE, CLOSED_SEAT, 0, START + 1_000),
  clientRow(CLOSED_SOURCE, CLOSED_SEAT, 1, START + 60_000),
  clientRow(CLOSED_SOURCE, CLOSED_SEAT, 2, END + 2_000, { event: "client.call_ended", end_reason: "episode_ended", client_session_id: "cs-synthetic-1" }),
  clientRow(OPEN_SOURCE, OPEN_SEAT, 0, START + 5_000),
  clientRow(OPEN_SOURCE, OPEN_SEAT, 2, START + 90_000),
  axiomRow(END, "chalk-sync", { event: "sync.episode.ended", event_id: "0e0000ee-0000-4000-8000-00000000s001", end_reason: "ended_by_participant" }),
];

/** @type {import("./world.mjs").DbEpisode} */
const DB = {
  episode: { id: EPISODE, tenant: TENANT, space: "0e000000-0000-4000-8000-000000000003", created_at: iso(START - 1_000), started_at: iso(START), ended_at: iso(END), end_reason: "ended_by_participant" },
  tenant: { id: TENANT, name: "Synthetic" },
  seats: [CLOSED_SEAT, OPEN_SEAT, QUIET_SEAT].map((participant, index) => ({
    participant,
    name: `Seat ${index + 1}`,
    role: "participant",
    capabilities: ["publishAudio", "subscribe"],
    generation: 1,
    connection: null,
    created_at: iso(START),
    joined_at: iso(START),
    left_at: iso(END),
    account: null,
    identity: null,
  })),
};

/** @param {import("./world.mjs").Ledger} [ledger] @returns {Stores} */
const fakeStores = (ledger = { tenant_id: TENANT, episode_id: EPISODE, sources: [closed, open] }) => ({
  declaration: async ({ episode }) => (episode === EPISODE ? DB : null),
  ledger: async () => ledger,
  rows: async () => ROWS,
  latest: async (services) => Object.fromEntries(services.map((service) => [service, NOW])),
});

test("a seq gap starts at the source's last row before it and ends at its first row at or after its end", () => {
  const rows = ROWS.map(unwrapRow);
  const coverage = sourceCoverage(open, rows, { asof_ms: NOW, start_ms: START });
  assert.deepEqual(coverage.evidence_gaps, [
    { from_ms: START + 5_000, to_ms: START + 90_000, reason: "missing seq 1..2 open" },
    { from_ms: START + 90_000, to_ms: null, reason: "tail_unknown seq 3..? open" },
  ]);
  assert.equal(coverage.complete_to_ms, START + 90_000, "an open source is complete only to its highest stored row");
  const fromZero = sourceCoverage({ ...open, gaps: [{ source_id: OPEN_SOURCE, from_seq: 0, to_seq: 9, cause: "missing", status: "final" }] }, rows, { asof_ms: NOW, start_ms: START });
  assert.deepEqual(fromZero.evidence_gaps, [{ from_ms: START, to_ms: null, reason: "missing seq 0..9 final" }], "no row before is the Episode start; no row after is an unknown end");
});

test("a closed source with no gaps is complete to asof, and covers its seat", () => {
  const w = clientWatermark(CLOSED_SEAT, { tenant_id: TENANT, episode_id: EPISODE, sources: [closed, open] }, ROWS.map(unwrapRow), { asof_ms: NOW, start_ms: START });
  assert.equal(w.complete_to_ms, NOW);
  assert.deepEqual(w.evidence_gaps, []);
  assert.equal(uncovered(w, { source: "client", subject: `pt:${CLOSED_SEAT}`, fact: "end.client_screen", window: { from_ms: START, to_ms: END + 120_000 } }), null);
});

test("a seat with an open gap, and a seat with no ledger source, stay unchecked, so the Episode is never healthy", async () => {
  const { world, notes } = liveWorld({ db: DB, ledger: { tenant_id: TENANT, episode_id: EPISODE, sources: [closed, open] }, rows: ROWS, latest: { "chalk-api": NOW, "chalk-sync": NOW, "chalk-sfu": NOW }, asof_ms: NOW });
  const marks = new Map(world.evidence[EPISODE].watermarks.map((w) => [`${w.source}|${w.subject}`, w]));
  assert.equal(marks.get(`client|pt:${QUIET_SEAT}`)?.complete_to_ms, null, "no ledger source means not read");
  assert.equal(marks.get(`client|pt:${OPEN_SEAT}`)?.evidence_gaps.length, 2);
  assert.match(notes[0], /read 6 rows/u);

  const result = await run(["--live", "--tenant", TENANT, "--episode", EPISODE, "episode", EPISODE, "--json"], { stores: fakeStores(), now: NOW });
  assert.equal(result.code, 0, result.err);
  const view = JSON.parse(result.out);
  assert.notEqual(view.head.outcome, "healthy");
  assert.equal(view.head.coverage.state, "partial");
  const text = await run(["--live", "--tenant", TENANT, "--episode", EPISODE, "episode", EPISODE], { stores: fakeStores(), now: NOW });
  const gaps = text.out.split("\n").filter((line) => line.startsWith("gap:"));
  assert.ok(gaps.some((line) => line.includes("end.wrong_screen")), `the open and quiet seats' end checks are gaps:\n${text.out}`);
  assert.match(text.out, /checked=1\//u, "only the closed seat's end check could decide");
});

test("an unreadable ledger leaves every seat's client source not read", async () => {
  const result = await run(["--live", "--tenant", TENANT, "--episode", EPISODE, "episode", EPISODE, "--json"], { stores: fakeStores({ unavailable: "relation does not exist" }), now: NOW });
  const view = JSON.parse(result.out);
  assert.notEqual(view.head.outcome, "healthy");
  assert.equal(view.head.coverage.state, "partial");
  assert.match(result.err, /telemetry ledger unread/u);
});

test("--live takes the Episode from flags and refuses a fixture or a missing id", async () => {
  assert.equal((await run(["--live", "--tenant", TENANT, "--fixture", "nov18", "episode", EPISODE], { stores: fakeStores(), now: NOW })).code, 64);
  assert.equal((await run(["--live", "--tenant", TENANT, "episode", EPISODE], { stores: fakeStores(), now: NOW })).code, 64);
  const notUuid = await run(["--live", "--tenant", "acme", "--episode", EPISODE, "episode", EPISODE], { stores: fakeStores(), now: NOW });
  assert.equal(notUuid.code, 69);
  const missing = await run(["--live", "--tenant", TENANT, "--episode", "0e000000-0000-4000-8000-0000000000ff", "episode", EPISODE], { stores: fakeStores(), now: NOW });
  assert.equal(missing.code, 69);
  assert.match(missing.err, /no Episode/u);
});

test("a seq the ledger stored but Axiom returned no timed row for is a gap, so a closed source does not cover it", () => {
  const rows = ROWS.map(unwrapRow).filter((row) => !(row.source_id === CLOSED_SOURCE && row.seq === 1));
  const untimed = { ...unwrapRow(clientRow(CLOSED_SOURCE, CLOSED_SEAT, 1, START + 60_000)), est_server_ms: undefined };
  for (const read of [rows, [...rows, untimed]]) {
    const w = clientWatermark(CLOSED_SEAT, { tenant_id: TENANT, episode_id: EPISODE, sources: [closed, open] }, read, { asof_ms: NOW, start_ms: START });
    assert.deepEqual(w.evidence_gaps, [{ from_ms: START + 1_000, to_ms: END + 2_000, reason: "unread seq 1..2 open" }]);
    assert.equal(uncovered(w, { source: "client", subject: `pt:${CLOSED_SEAT}`, fact: "end.client_screen", window: { from_ms: START, to_ms: END + 120_000 } })?.why, "evidence_gap");
  }
});

test("a gap whose neighbours' clocks run backwards still covers the time between them", () => {
  const rows = [clientRow(OPEN_SOURCE, OPEN_SEAT, 0, START + 90_000), clientRow(OPEN_SOURCE, OPEN_SEAT, 2, START + 5_000, { clock_err_ms: 500 })].map(unwrapRow);
  const [missing] = sourceCoverage(open, rows, { asof_ms: NOW, start_ms: START }).evidence_gaps;
  assert.deepEqual(missing, { from_ms: START + 4_500, to_ms: START + 90_000, reason: "missing seq 1..2 open" });
});

test("an Axiom refusal is a store error, so diagnose exits 69 instead of crashing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("denied", { status: 401 }));
  const stores = realStores({ AXIOM_TOKEN: "synthetic", CHALK_LOG_DATASET: "synthetic-logs" });
  await assert.rejects(stores.rows(EPISODE, { from_ms: START, to_ms: END }), StoreError);
  await assert.rejects(stores.latest(["chalk-api"], { from_ms: START, to_ms: END }), StoreError);
});

test("a legacy row is renamed to its registry event by the registry's match", () => {
  const row = unwrapRow({ _time: iso(START), service: { name: "chalk-api" }, attributes: { event: "sdk.telemetry", type: "call_ended", episode_id: EPISODE } });
  assert.equal(row.event, "client.call_ended");
  assert.equal(row.service, "chalk-api");
});

test("a seq the API rejected for its content is a gap, so a closed source does not read it as absent", () => {
  /** @type {LedgerSource} */
  const rejecting = {
    ...closed,
    watermark: {
      ...closed.watermark,
      stored: [
        { from: 0, to: 1 },
        { from: 2, to: 3 },
      ],
      rejected: [{ from: 1, to: 2 }],
    },
  };
  const rows = ROWS.map(unwrapRow).filter((row) => !(row.source_id === CLOSED_SOURCE && row.seq === 1));
  const w = clientWatermark(CLOSED_SEAT, { tenant_id: TENANT, episode_id: EPISODE, sources: [rejecting] }, rows, { asof_ms: NOW, start_ms: START });
  assert.deepEqual(w.evidence_gaps, [{ from_ms: START + 1_000, to_ms: END + 2_000, reason: "rejected seq 1..2 final" }]);
  assert.equal(uncovered(w, { source: "client", subject: `pt:${CLOSED_SEAT}`, fact: "end.client_screen", window: { from_ms: START, to_ms: END + 120_000 } })?.why, "evidence_gap");
});

test("rows shaped like the API sink's sdk.telemetry rows carry no est_server_ms, so their seat stays partial, never complete", () => {
  // sdktelemetry.Log writes type, seq, elapsed_ms, source_id, batch_id and received_at; nothing stamps a server time yet.
  const logRow = (/** @type {number} */ seq, extra = {}) =>
    unwrapRow({
      _time: iso(START + seq * 1_000),
      service: { name: "chalk-api" },
      attributes: { event: "sdk.telemetry", type: "heartbeat", seq, elapsed_ms: seq * 1_000, source_id: OPEN_SOURCE, batch_id: "0e000000-0000-4000-8000-0000000000f6", received_at: iso(START + seq * 1_000), episode_id: EPISODE, participant_id: OPEN_SEAT, ...extra },
    });
  /** @type {LedgerSource} */
  const source = { ...open, watermark: { ...open.watermark, stored: [{ from: 0, to: 3 }] }, gaps: [] };
  const coverage = sourceCoverage(source, [logRow(0), logRow(1), logRow(2, { type: "call_ended", end_reason: "episode_ended" })], { asof_ms: NOW, start_ms: START });
  assert.equal(coverage.complete_to_ms, null);
  assert.deepEqual(coverage.evidence_gaps, [{ from_ms: START, to_ms: null, reason: "unread seq 0..3 open" }]);
});

test("a psql failure prints a fixed message, never psql's stderr, which names the database user and host", () => {
  const stderr = 'psql: error: connection to server at "127.0.0.1", port 5432 failed: FATAL:  role "synthetic" does not exist';
  assert.equal(psqlFailure({ code: 2, stderr }), "connect to the declaration database failed");
  assert.equal(psqlFailure({ code: 3, stderr }), "the declaration query failed");
  assert.equal(psqlFailure({ code: "ENOENT" }), "psql is not installed");
  assert.doesNotMatch(psqlFailure({ code: 1, stderr }), /synthetic|127\.0\.0\.1/u);
});

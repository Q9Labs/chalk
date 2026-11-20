// @ts-check
// What the live reader may take as proof: a server row's recency is not completeness, a build emits only what its rows show, a client
// row counts only when the ledger stored its seq, a live read without --store is a fresh read, and every printed command carries the
// world it came from. Every id and row here is made up.
import assert from "node:assert/strict";
import test from "node:test";
import { run } from "../diagnose.mjs";
import { uncovered } from "../proof/evidence.mjs";
import { liveWorld } from "./world.mjs";

/** @typedef {import("./world.mjs").LedgerSource} LedgerSource */
/** @typedef {import("./stores.mjs").Stores} Stores */

const TENANT = "0e100000-0000-4000-8000-000000000001";
const EPISODE = "0e100000-0000-4000-8000-000000000002";
const SEAT = "0e100000-0000-4000-8000-0000000000a1";
const SOURCE = "0e100000-0000-4000-8000-0000000000d4";
const START = Date.parse("2026-01-05T10:00:00Z");
const END = START + 30 * 60_000;
const NOW = END + 10 * 60_000;
const iso = (/** @type {number} */ at) => new Date(at).toISOString();

/** @type {LedgerSource} */
const closed = { source_id: SOURCE, watermark: { tenant_id: TENANT, participants: [SEAT], episodes: [EPISODE], next_seq: 3, end: "closed", stored: [{ from: 0, to: 3 }] }, gaps: [] };
const BUILD = { sdk_version: "3.1.0", platform: "web", schema_ver: 2 };
const axiomRow = (/** @type {number} */ at, /** @type {string} */ service, /** @type {Record<string, unknown>} */ attributes) => ({ _time: iso(at), service: { name: service }, attributes: { tenant_id: TENANT, episode_id: EPISODE, est_server_ms: at, ...attributes } });
const clientRow = (/** @type {number} */ seq, /** @type {number} */ at, extra = {}) => axiomRow(at, "chalk-api", { kind: "op", name: "client.heartbeat", event_id: `0e1000ee-0000-4000-8000-${String(seq).padStart(12, "0")}`, source_id: SOURCE, seq, participant_id: SEAT, ...BUILD, ...extra });
const ended = (/** @type {number} */ seq, end_reason = "episode_ended") => clientRow(seq, END + 2_000, { kind: "fact", name: "client.call_ended", end_reason });
const SYNC_END = axiomRow(END, "chalk-sync", { kind: "fact", name: "sync.episode.ended", event_id: "0e1000ee-0000-4000-8000-0000000005e1", end_reason: "ended_by_participant", release_sha: "abc123" });

/** @type {import("./world.mjs").DbEpisode} */
const DB = {
  episode: { id: EPISODE, tenant: TENANT, space: "0e100000-0000-4000-8000-000000000003", created_at: iso(START - 1_000), started_at: iso(START), ended_at: iso(END), end_reason: "ended_by_participant" },
  tenant: { id: TENANT, name: "Synthetic" },
  seats: [{ participant: SEAT, name: "Seat 1", role: "participant", capabilities: ["subscribe"], generation: 1, connection: null, created_at: iso(START), joined_at: iso(START), left_at: iso(END), account: "0e100000-0000-4000-8000-0000000000b1", identity: null }],
};
const LEDGER = { tenant_id: TENANT, episode_id: EPISODE, sources: [closed] };
const ROWS = [clientRow(0, START + 1_000), clientRow(1, START + 60_000), ended(2), SYNC_END];

/** @param {readonly object[]} rows */
const worldOf = (rows) => liveWorld({ db: DB, ledger: LEDGER, rows, asof_ms: NOW });
/** @param {ReturnType<typeof worldOf>} live @param {string} key */
const markOf = (live, key) => live.world.evidence[EPISODE].watermarks.find((w) => `${w.source}|${w.subject}` === key);

/** @param {readonly object[]} [rows] @returns {Stores} */
const stores = (rows = ROWS) => ({ declaration: async () => DB, ledger: async () => LEDGER, rows: async () => [...rows] });

test("a server source with no ledger is not read, however recent its latest row", () => {
  const live = liveWorld(/** @type {any} */ ({ db: DB, ledger: LEDGER, rows: ROWS, latest: { "chalk-api": NOW, "chalk-sync": NOW, "chalk-sfu": NOW }, asof_ms: NOW }));
  for (const source of ["api", "sync", "sfu"]) assert.equal(markOf(live, `${source}|*`)?.complete_to_ms, null, `${source} has no completeness signal`);
});

test("a source emits only the facts its rows show at that build, so a fact never seen at a build is not emitted", () => {
  const quiet = worldOf([clientRow(0, START + 1_000), clientRow(1, START + 60_000), clientRow(2, END + 2_000)]);
  const mark = markOf(quiet, `client|pt:${SEAT}`);
  assert.deepEqual(mark?.emits, []);
  assert.equal(uncovered(mark, { source: "client", subject: `pt:${SEAT}`, fact: "end.client_screen", window: { from_ms: START, to_ms: END + 120_000 } })?.why, "not_emitted");
  assert.deepEqual(markOf(worldOf(ROWS), `client|pt:${SEAT}`)?.emits, ["end.client_screen"]);
});

test("a client row whose seq the ledger did not store, or whose source it does not know, is ignored and counted", () => {
  const stray = ended(7);
  const unknown = { ...ended(2), attributes: { ...ended(2).attributes, source_id: "0e100000-0000-4000-8000-0000000000ff", event_id: "0e1000ee-0000-4000-8000-0000000000ff" } };
  const live = worldOf([...ROWS, stray, unknown]);
  const ids = live.world.evidence[EPISODE].observations.map((o) => o.id);
  assert.ok(!ids.includes(String(stray.attributes.event_id)), "an unstored seq is not evidence");
  assert.ok(!ids.includes(String(unknown.attributes.event_id)), "a source the ledger does not know is not evidence");
  assert.ok(
    live.notes.some((note) => /ignored 2 client rows the ledger did not store/u.test(note)),
    live.notes.join("\n"),
  );
});

test("a ledger source of another Tenant does not cover the seat, and its rows are not evidence", () => {
  const foreign = { ...closed, watermark: { ...closed.watermark, tenant_id: "0e100000-0000-4000-8000-0000000000ee" } };
  const live = liveWorld({ db: DB, ledger: { ...LEDGER, sources: [foreign] }, rows: ROWS, asof_ms: NOW });
  assert.equal(markOf(live, `client|pt:${SEAT}`)?.complete_to_ms, null);
  assert.ok(!live.world.evidence[EPISODE].observations.some((o) => o.source === "client"));
});

test("a rejected range is one gap whether the ledger reports it as a gap, in its watermark, or both", () => {
  const rejected = {
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
  const reported = { ...rejected, gaps: [{ source_id: SOURCE, from_seq: 1, to_seq: 2, cause: "rejected", status: /** @type {const} */ ("final") }] };
  for (const source of [rejected, reported]) {
    const live = liveWorld({ db: DB, ledger: { ...LEDGER, sources: [source] }, rows: ROWS, asof_ms: NOW });
    const mark = markOf(live, `client|pt:${SEAT}`);
    assert.deepEqual(
      mark?.evidence_gaps.map((gap) => gap.reason),
      ["rejected seq 1..2 final"],
    );
    assert.ok(!live.world.evidence[EPISODE].observations.some((o) => o.id === String(ROWS[1].attributes.event_id)), "a rejected seq's row is not evidence");
  }
});

test("a live read without --store prints a fresh read, never a retained history", async () => {
  const result = await run(["--live", "--tenant", TENANT, "--episode", EPISODE, "episode", EPISODE], { stores: stores(), now: NOW });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out.split("\n")[0], / read=fresh /u);
  assert.doesNotMatch(result.out, /retained/u);
  assert.match(result.err, /fresh read/u);
});

test("every printed next: command carries the live world it came from, and runs as printed", async () => {
  const selector = `--live --tenant ${TENANT} --episode ${EPISODE}`;
  const lost = stores([clientRow(0, START + 1_000), clientRow(1, START + 60_000), ended(2, "connection_lost"), SYNC_END]);
  const result = await run(["--live", "--tenant", TENANT, "--episode", EPISODE, "episode", EPISODE], { stores: lost, now: NOW });
  const commands = result.out.split("\n").filter((line) => line.startsWith("next: diagnose "));
  assert.ok(commands.length > 0, result.out);
  for (const line of commands) {
    assert.ok(line.endsWith(selector), line);
    const again = await run(line.slice("next: diagnose ".length).split(" "), { stores: lost, now: NOW });
    assert.equal(again.code, 0, `${line}: ${again.err}`);
  }
});

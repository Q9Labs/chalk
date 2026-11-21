// @ts-check
// Hop (b) of the media chains: stamps each hop's rows into the rows a Postgres ledger stores
// (participant, Episode and clock stamps are pinned; the row's own fields are unchanged), then
// judges the symptom's rule the way the coverage gate does. The client hops are
// sdks/typescript/client/src/media/client.fault.test.ts and the React tile hop; the SFU hop is
// features/media/sfu/internal/media/video_chain_test.go; the Sync hop is
// apps/sync/test/chalk_sync/obs_video_chain_test.exs. CHALK_CHAIN_WRITE=1 rewrites the files.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { judgeFixture, ruleResult } from "./rows.mjs";
import { CATALOGUE } from "./catalogue.mjs";

const root = new URL("../../../", import.meta.url);
const read = (/** @type {string} */ path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

const EPISODE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const TENANT = "c1000000-0000-4000-8000-000000000001";
const SPACE = "d1000000-0000-4000-8000-000000000001";
const PUBLISHER = "a1000000-0000-4000-8000-000000000001";
const VIEWER = "b2000000-0000-4000-8000-000000000002";
const SOURCE = "e1000000-0000-4000-8000-000000000001";
const WINDOW = { from_ms: 1_795_599_000_000, to_ms: 1_795_601_000_000 };

/** @param {string} seat @returns {import("./profile.mjs").Declaration} */
const declaration = (seat) => ({
  kind: "episode",
  id: EPISODE,
  tenant: TENANT,
  features: [],
  window: WINDOW,
  seats: [
    {
      participant: seat,
      name: "Seat A",
      role: "participant",
      can_publish: true,
      generations: [1],
      connections: [],
      window: WINDOW,
      person: { kind: "user", id: "f1000000-0000-4000-8000-000000000001", name: "Seat A" },
    },
  ],
});

const CHAIN = (/** @type {string} */ code) => `observability/fixtures/${code}/chain`;

/** One wire event as the ledger stores it. @param {string} seat */
const stored = (seat) => (/** @type {Record<string, unknown>} */ row) => {
  const wall = typeof row.client_wall_ms === "number" ? row.client_wall_ms : WINDOW.from_ms;
  return { clock_state: "synced", env: "test", episode_id: EPISODE, est_server_ms: wall, generation: 1, participant_id: seat, source_id: SOURCE, space_id: SPACE, tenant_id: TENANT, ...row, est_server_ms: wall };
};

/** An SFU journal record as the ledger stores it: the relay stamps est_server_ms on export; the
 * scripted emission order spaces rows 20 s apart, matching the counters they carry. */
const sfuStamped = (/** @type {Record<string, unknown>} */ row, /** @type {number} */ index) => {
  // The export whitelist carries the event, its declared fields and the scope stamps; the journal's
  // session internals (connection_id, session_kind, node_incarnation) stay on the node.
  const { connection_id: _conn, session_kind: _kind, node_incarnation: _inc, ...exported } = row;
  return {
    clock_state: "synced",
    env: "test",
    space_id: SPACE,
    source_id: SOURCE,
    event_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    ...exported,
    est_server_ms: WINDOW.from_ms + index * 20_000,
  };
};

function rowsFor(/** @type {string} */ code, /** @type {string} */ file, /** @type {string} */ seat) {
  const stamped = read(`${CHAIN(code)}/${file}`).map(stored(seat));
  return { path: `${CHAIN(code)}/${file}`, rows: stamped };
}

function sfuRows(/** @type {string} */ code, /** @type {string} */ run) {
  const path = `${CHAIN(code)}/sfu-rows.${run}.json`;
  return { path, rows: read(path).map(sfuStamped) };
}

/** @returns {readonly {path: string, rows: Record<string, unknown>[]}[]} */
function hops(/** @type {string} */ code, /** @type {string} */ run) {
  const seat = code === "video.not_published" ? PUBLISHER : VIEWER;
  const parts = code === "video.not_published"
    ? [rowsFor(code, "client-frames.healthy.json", seat), rowsFor(code, `client-stats.${run}.json`, seat), sfuRows(code, run), { path: `${CHAIN(code)}/sync-rows.json`, rows: read(`${CHAIN(code)}/sync-rows.json`) }]
    : [rowsFor(code, `client-stats.${run}.json`, seat), rowsFor(code, `tile-frames.${run}.json`, seat), sfuRows(code, run)];
  return parts;
}

function fixture(/** @type {string} */ code, /** @type {"positive" | "healthy"} */ kind, /** @type {string} */ description) {
  const seat = code === "video.not_published" ? PUBLISHER : VIEWER;
  const parts = hops(code, kind);
  const all = parts.flatMap((part) => part.rows);
  // The assembly's stamped rows are the fixture's chain file: the fixture's rows are exactly its.
  const stampedPath = `${CHAIN(code)}/rows.${kind}.json`;
  if (process.env.CHALK_CHAIN_WRITE === "1") writeFileSync(new URL(stampedPath, root), `${JSON.stringify(all, null, 2)}\n`);
  const fixture = { description, asof_ms: WINDOW.to_ms, declaration: declaration(seat), chain: [stampedPath], rows: all };
  const file = `observability/fixtures/${code}/${kind}.json`;
  const text = `${JSON.stringify(fixture, null, 2)}\n`;
  if (process.env.CHALK_CHAIN_WRITE === "1") writeFileSync(new URL(file, root), text);
  assert.deepEqual(read(file), JSON.parse(text), `${file} is stale: rerun this hop with CHALK_CHAIN_WRITE=1`);
  return fixture;
}

describe("video media chain, hop (b)", () => {
  for (const [code, kind, description] of /** @type {const} */ ([
    ["video.not_published", "positive", "The seat's camera went live+bound and its encoder produced frames, but the SFU never registered the camera publication and its ingress rows sit at zero; the microphone published fine beside it."],
    ["video.not_published", "healthy", "The seat's camera went live+bound, the SFU registered it and its ingress flowed."],
    ["video.not_shown", "positive", "The viewer's camera subscription exists but the SFU's forward counters stay at zero while the publisher's ingress flows; the tile shows the avatar."],
    ["video.not_shown", "healthy", "The subscription forwards, the track and the presented frames grow, and the tile shows picture."],
    ["video.frozen", "positive", "The camera forwards and the track flows, but the on-screen tile's presented frames stop growing for more than 8 s."],
    ["video.frozen", "healthy", "The tile's presented frames keep growing."],
    ["video.low_quality", "positive", "The picture shows at a starved bitrate under the SFU's lowest plan while the downlink marks congestion and drops."],
    ["video.low_quality", "healthy", "The picture shows at a healthy bitrate with no congestion mark."],
  ])) {
    it(`${code} ${kind}: the rule and the chain agree`, () => {
      const judged = judgeFixture(fixture(code, kind, ""), CATALOGUE, code);
      assert.equal(judged.dropped.length, 0, JSON.stringify(judged.dropped));
      const result = ruleResult(judged.verdict, code);
      if (kind === "positive") assert.equal(result.findings, 1, JSON.stringify(judged.verdict.findings));
      else assert.deepEqual(result, { findings: 0, checked: 1, eligible: 1 }, JSON.stringify(judged.verdict));
    });
  }
});

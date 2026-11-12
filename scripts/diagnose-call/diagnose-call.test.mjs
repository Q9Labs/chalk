import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseRows, thresholds } from "./index.mjs";
import { assertEveryRowJoined, joinByIds, joinedShare, SOURCES } from "./join.mjs";
import { render } from "./render.mjs";
import { normalizeRow } from "./rows.mjs";
import { verdictLine } from "./verdict.mjs";

import { EPISODE, T0, api, at, callStats, dormantReplacementCall, flow, hashOf, scenarios, starvedViewerCall } from "./scenarios.mjs";

const verdictOf = (rows) =>
  diagnoseRows(
    EPISODE,
    rows.map((row) => normalizeRow(row)),
  );

test("a connection replaced as dormant that the node never resumed is named as the cause of the silence", () => {
  const { findings } = verdictOf(dormantReplacementCall());
  const silence = findings.find((finding) => finding.kind === "media_silence");
  assert.ok(silence, "the silence was not found");
  assert.equal(silence.participant, hashOf.viewer);
  assert.match(silence.cause, /replaced \(dormant_connection\)/u);
  assert.ok(silence.to - silence.from > thresholds.silence_ms);
  assert.match(verdictLine(findings), /^Participant [0-9a-f]{8} received no media for \d+ s while a sender was sending from \d\d:\d\d:\d\d to \d\d:\d\d:\d\d UTC; cause: the connection was replaced/u);
});

test("a viewer held at 26 kbps on a healthy link is named with the layer limit that held it", () => {
  const { findings } = verdictOf(starvedViewerCall());
  assert.equal(findings[0].kind, "starved_viewer");
  assert.match(findings[0].experience, /26 kbps or less for \d+ s on a healthy link/u);
  assert.match(findings[0].cause, /node held the viewer to the low layer \(server limit low, viewer ceiling high\)/u);
});

test("the same low bitrate on a link with loss is not called starvation", () => {
  const rows = starvedViewerCall().map((row) => (row.attributes.event === "sdk.call_stats" ? { ...row, attributes: { ...row.attributes, recv_loss_pct: 9 } } : row));
  assert.deepEqual(verdictOf(rows).findings, []);
});

test("a failed join names the API refusal that shares the report's journey id", () => {
  const journey = "journey-1";
  const rows = [api(5, "sdk.connection_report", "viewer", { trigger: "join_failed", journey_id: journey }), api(5, "http.failure", "viewer", { error_code: "episode.full", journey_id: journey })];
  const { findings } = verdictOf(rows);
  assert.equal(findings[0].kind, "failed_join");
  assert.match(findings[0].cause, /episode\.full/u);
});

test("a replacement within 20 s of the join is flagged and one later is not", () => {
  const early = [api(1, "http.request", "viewer", {}), api(13, "media.connection_replacement", "viewer", { replacement_cause: "access_refresh" })];
  assert.equal(verdictOf(early).findings[0].kind, "early_replacement");
  const late = [api(1, "http.request", "viewer", {}), api(60, "media.connection_replacement", "viewer", { replacement_cause: "access_refresh" })];
  assert.deepEqual(verdictOf(late).findings, []);
});

test("a receiver that never took media is a failed start, not silence", () => {
  const rows = [...flow("conn-pub"), ...callStats("viewer", "conn-view", 0, 100, () => ({ recv_bitrate_kbps: 0, recv_height: 640 }))];
  assert.deepEqual(verdictOf(rows).findings, []);
});

test("a call nobody sends into is not silence", () => {
  const rows = [...callStats("publisher", "conn-pub", 0, 100, () => ({ send_bitrate_kbps: 0 })), ...callStats("viewer", "conn-view", 0, 100, () => ({ recv_bitrate_kbps: 0 }))];
  assert.deepEqual(verdictOf(rows).findings, []);
});

test("a call with media flowing has no finding", () => {
  const rows = [...flow("conn-pub"), ...callStats("viewer", "conn-view", 0, 300, () => ({ recv_bitrate_kbps: 1400, recv_height: 720 }))];
  const result = verdictOf(rows);
  assert.deepEqual(result.findings, []);
  assert.match(verdictLine(result.findings), /^No bad call found/u);
});

/** One row for every source the diagnosis reads, each reachable by a different id. */
function everySource() {
  return [
    ...dormantReplacementCall(),
    // Sync spans name the Episode and the hash, not a connection.
    { _time: at(1), "service.name": "chalk-sync", name: "sync.participant.socket_up", attributes: { custom: { episode_id: EPISODE, participant_id_hash: hashOf.viewer } } },
    // A node event for a pause carries the connection but may lack the Episode.
    { _time: at(120), "service.name": "chalk-sfu", attributes: { event: "sfu.subscription.paused", connection_id: "conn-view-2", reason: "viewer" } },
    // A line of the failed request carries the journey id of a row that names the Episode.
    api(7, "http.failure", "viewer", { journey_id: "journey-9" }),
    { _time: at(7), "service.name": "chalk-api", attributes: { event: "media.track_close", journey_id: "journey-9" } },
  ];
}

test("every source row of a call is reached by an id, and the output says how many were", () => {
  const rows = everySource().map((row) => normalizeRow(row));
  rows.push({ source: "db", event: "db.participant", time: T0, episode: EPISODE, participant: hashOf.viewer, connection: "conn-view", attrs: {} });
  const result = joinByIds(EPISODE, rows);
  assertEveryRowJoined(result);
  for (const source of SOURCES) assert.equal(joinedShare(result.stats[source]), 1, source);
  assert.ok(result.stats.sfu.connection >= 1, "the node event without an Episode id joined by connection id");
  assert.ok(result.stats.api.journey >= 1, "the API line without an Episode id joined by journey id");
  const text = render({ ...diagnoseRows(EPISODE, rows), elapsedMs: 1234 });
  assert.match(text, /^VERDICT: /mu);
  assert.match(text, /all\s+\d+.*100%/u);
  assert.match(text, /Elapsed: 1\.2 s$/u);
});

test("a source row that names no id fails the join check", () => {
  const rows = everySource().map((row) => normalizeRow(row));
  rows.push(normalizeRow({ _time: at(50), "service.name": "chalk-sfu", attributes: { event: "sfu.subscription.layer", layer: "low" } }));
  const result = joinByIds(EPISODE, rows);
  assert.equal(result.stats.sfu.unjoined, 1);
  assert.throws(() => assertEveryRowJoined(result), /sfu:sfu\.subscription\.layer/u);
});

test("a row of another call is neither joined nor counted as lost", () => {
  const rows = [...everySource().map((row) => normalizeRow(row)), normalizeRow({ _time: at(5), "service.name": "chalk-sfu", attributes: { event: "sfu.session.registered", episode_id: "other-episode", connection_id: "conn-other" } })];
  const result = joinByIds(EPISODE, rows);
  assert.equal(result.unjoined.length, 0);
  assert.ok(!result.joined.some((row) => row.connection === "conn-other"));
});

test("evidence the rows lack is listed: a Participant with no inbound rows and no node events", () => {
  const rows = callStats("viewer", "conn-view", 0, 60, () => ({ send_bitrate_kbps: 900 })).map((row) => normalizeRow(row));
  const { missing } = diagnoseRows(EPISODE, rows);
  assert.ok(missing.some((line) => /no inbound rows/u.test(line)));
  assert.ok(missing.some((line) => /no sfu rows/u.test(line)));
  assert.ok(missing.some((line) => /no sync rows/u.test(line)));
});

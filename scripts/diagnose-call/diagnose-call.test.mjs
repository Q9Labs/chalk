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
  assert.match(verdictLine(findings), /^Participant [0-9a-f]{8} received no media for \d+ s while a sender was sending from \d\d:\d\d:\d\d to \d\d:\d\d:\d\d UTC; failing stage: reconnecting, side: API; cause: the connection was replaced/u);
});

test("a viewer held at 26 kbps on a healthy link is named with the layer limit that held it", () => {
  const { findings } = verdictOf(starvedViewerCall());
  assert.equal(findings[0].kind, "starved_viewer");
  assert.match(findings[0].experience, /26 kbps or less for \d+ s on a healthy link/u);
  assert.match(findings[0].cause, /node held the viewer to the low layer \(server limit low, viewer ceiling high\)/u);
});

test("the same low bitrate on a link with loss is the viewer's network, not starvation", () => {
  const rows = starvedViewerCall().map((row) => (row.attributes.event === "sdk.call_stats" ? { ...row, attributes: { ...row.attributes, recv_loss_pct: 9 } } : row));
  const [finding] = verdictOf(rows).findings;
  assert.equal(finding.kind, "congested_viewer");
  assert.equal(finding.side, "network");
  assert.match(finding.cause, /9% loss at worst/u);
});

test("a viewer held by the node, one that capped itself and a publisher that sent no better layer are told apart", () => {
  const withLayer = (layer) => starvedViewerCall().map((row) => (row.attributes.event === "sfu.subscription.layer" ? { ...row, attributes: { ...row.attributes, ...layer } } : row));
  const sideOf = (layer) => verdictOf(withLayer(layer)).findings[0].side;
  assert.equal(sideOf({}), "SFU");
  assert.equal(sideOf({ ceiling: "low", server_limit: "high" }), "viewer");
  assert.equal(sideOf({ ceiling: "high", server_limit: "high" }), "publisher");
});

test("a publisher whose sender reports 0 kbps while the viewer waits is the publisher's side", () => {
  const [finding] = verdictOf(scenarios["publisher sent nothing"]()).findings;
  assert.equal(finding.kind, "publisher_silent");
  assert.equal(finding.participant, hashOf.publisher);
  assert.equal(finding.side, "publisher");
  assert.match(finding.cause, /accepted the publication/u);
});

test("a node that paused the subscription for congestion is the network, for the viewer's own pause it is the viewer", () => {
  const paused = (reason) => [
    ...dormantReplacementCall().filter((row) => !String(row.attributes.event).startsWith("media.")),
    { _time: at(100), "service.name": "chalk-sfu", attributes: { event: "sfu.subscription.paused", episode_id: EPISODE, participant_id: "participant-viewer", connection_id: "conn-view-2", reason } },
  ];
  const silence = (reason) => verdictOf(paused(reason)).findings.find((finding) => finding.kind === "media_silence");
  assert.equal(silence("congestion").side, "network");
  assert.equal(silence("viewer").side, "viewer");
  assert.equal(silence("planner").side, "SFU");
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

test("a call nobody sends into is not silence, and a lone Participant who sends nothing is not a bad call", () => {
  const rows = [...callStats("publisher", "conn-pub", 0, 100, () => ({ send_bitrate_kbps: 0 })), ...callStats("viewer", "conn-view", 0, 100, () => ({ recv_bitrate_kbps: 0 }))];
  assert.deepEqual(
    verdictOf(rows).findings.map((finding) => finding.kind),
    ["publisher_silent"],
  );
  assert.equal(verdictOf(rows).findings[0].side, "publisher");
  assert.match(verdictOf(rows).findings[0].cause, /node's part is not proved/u);
  assert.deepEqual(verdictOf(callStats("publisher", "conn-pub", 0, 100, () => ({ send_bitrate_kbps: 0 }))).findings, []);
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

test("a viewer that hid the video itself is named as its own choice, not as a bad call, and without the field the same rows are silence", () => {
  const withField = (hidden) => [...flow("conn-pub"), ...callStats("viewer", "conn-view", 0, 300, (second) => ({ recv_bitrate_kbps: second < 20 ? 1200 : 0, recv_height: 720, ...(hidden ? { recv_hidden_videos: 1 } : {}) }))];
  const hidden = verdictOf(withField(true)).findings;
  assert.deepEqual(
    hidden.map((finding) => [finding.kind, finding.benign, finding.side]),
    [["viewer_hid_video", true, "viewer"]],
  );
  assert.match(verdictLine(hidden), /^No bad call found by the rules.*Participant [0-9a-f]{8} hid its own video.*side: viewer, by choice/u);
  assert.equal(verdictOf(withField(false)).findings[0]?.kind, "media_silence");
});

test("a failed join with no failed API request is placed by the step the client report says failed first", () => {
  const events = [
    { event: "space_join_span", step: "access_initialize", outcome: "succeeded" },
    { event: "space_join_span", step: "wait_for_sync_live", outcome: "failed", code: "sync_start_failed", duration_ms: 30021 },
    { event: "space_join_span", step: "join", outcome: "failed", code: "sync_start_failed", duration_ms: 33151 },
  ];
  const [finding] = verdictOf([api(5, "sdk.connection_report", "viewer", { trigger: "join_failed", report: JSON.stringify({ trigger: "join_failed", events }) })]).findings;
  assert.deepEqual([finding.stage, finding.side], ["wait_for_sync_live", "Sync"]);
  assert.match(finding.cause, /sync_start_failed\) after 30 s/u);
  const [bare] = verdictOf([api(5, "sdk.connection_report", "viewer", { trigger: "join_failed", report: "not json" })]).findings;
  assert.equal(bare.side, "unknown");
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ROW_CAP } from "./axiom.mjs";
import { connectionEnv, episodeSql, readDatabase } from "./database.mjs";
import { diagnoseRows, strictCode, thresholds } from "./index.mjs";
import { assertEveryRowJoined, joinByIds, joinedShare, SOURCES } from "./join.mjs";
import { render } from "./render.mjs";
import { normalizeRow } from "./rows.mjs";
import { EPISODE, T0, at, dormantReplacementCall, fixture, hashOf, neverConnectedCall, scenarios, starvedViewerCall, starvedWithoutNodeCall, stuckAudioCall } from "./scenarios.mjs";
import { readSources } from "./sources.mjs";

const run = promisify(execFile);
const normalized = (rows) => rows.map((row) => normalizeRow(row));
const diagnose = (rows, gaps = []) => diagnoseRows(EPISODE, normalized(rows), gaps);
const kinds = (result) => result.findings.map((finding) => finding.kind);

test("the real row shape keeps the node's service and event: a flat null never overwrites a nested value", () => {
  const [node] = normalized(neverConnectedCall().filter((row) => row.attributes?.event === "sfu.session.closed"));
  assert.equal(node.source, "sfu");
  assert.equal(node.event, "sfu.session.closed");
  assert.equal(node.participant, hashOf.viewer);
  assert.equal(node.connection, "conn-view");
});

test("a never_connected session is named with what the node saw, the side it cannot prove, and the rows that prove it", () => {
  const result = diagnose(neverConnectedCall());
  const finding = result.findings.find((candidate) => candidate.kind === "never_connected");
  assert.equal(finding.participant, hashOf.viewer);
  assert.equal(finding.stage, "connecting");
  assert.equal(finding.side, "unknown");
  assert.match(finding.cause, /ICE checking but never a connected path/u);
  assert.match(finding.cause, /do not say which end blocked it/u);
  assert.ok(finding.proof.ids.length >= 2 && finding.proof.ids.every((id) => /^fx-\d{4}$/u.test(id)));
  assert.match(result.verdict, /had no media path.*failing stage: connecting, side: unknown/u);
  assert.doesNotMatch(result.verdict, /No bad call/u);
});

test("a never_connected session with no peer state says negotiation never began on the node", () => {
  const finding = diagnose(scenarios["never connected without peer states"]()).findings.find((candidate) => candidate.kind === "never_connected");
  assert.match(finding.cause, /negotiation never began on the node/u);
});

test("a Participant whose presence expired is named as having left without leaving", () => {
  const finding = diagnose(neverConnectedCall()).findings.find((candidate) => candidate.kind === "connection_expired");
  assert.match(finding.experience, /presence expired after 65 s unseen/u);
  assert.equal(finding.side, "client");
});

test("a session the node closed for a failed peer or a failed negotiation is a finding with its own cause", () => {
  const closed = (cause) => neverConnectedCall().map((row) => (row.attributes?.event === "sfu.session.closed" ? { ...row, attributes: { ...row.attributes, cause } } : row));
  assert.match(diagnose(closed("peer_failed")).findings.find((candidate) => candidate.kind === "peer_failed").cause, /ICE or DTLS failed/u);
  assert.match(diagnose(closed("negotiation_failed")).findings.find((candidate) => candidate.kind === "negotiation_failed").cause, /could not apply an offer or answer/u);
  assert.deepEqual(kinds(diagnose(closed("removed"))), ["connection_expired"]);
});

test("a refused session, a refused admission and a failed ICE state are findings", () => {
  const f = fixture();
  const rows = [...f.cast(), f.node(1, "sfu.session.refused", "viewer", "conn-view", { code: "stale_generation" }), f.node(2, "sfu.admission.refused", "viewer", "conn-view", { reason: "full", sessions: 40 }), f.node(3, "sfu.ice.state", "publisher", "conn-pub", { state: "failed" })];
  const found = diagnose(rows).findings;
  assert.deepEqual(kinds({ findings: found }).toSorted(), ["admission_refused", "peer_failed", "session_refused"]);
  assert.match(found.find((finding) => finding.kind === "session_refused").cause, /stale_generation/u);
});

test("an Episode no row reaches is not a good call, and a call with a missing source is not either", () => {
  const empty = diagnose([]);
  assert.match(empty.verdict, /^Not enough evidence: no row reached this Episode/u);
  const partial = diagnose(scenarios["missing sources"]());
  assert.match(partial.verdict, /^Not enough evidence.*Missing sources: API, SFU node, Sync, database\./u);
  assert.doesNotMatch(partial.verdict, /No bad call/u);
});

test("a call with every source and flowing media is a clean call, and a lease revoked as the Participant leaves is not a cause", () => {
  const result = diagnose(scenarios["clean call"]());
  assert.deepEqual(result.findings, []);
  assert.deepEqual(
    result.gaps.filter((gap) => gap.blocks),
    [],
  );
  assert.match(result.verdict, /^No bad call found by the rules in the rows of every source/u);
});

test("a lease the node lost while the publisher was still in the call is the cause of a silent viewer", () => {
  const f = fixture();
  const rows = [
    ...f.cast(),
    ...f.flow(),
    ...f.stats("viewer", "conn-view", 0, 300, () => ({ recv_bitrate_kbps: 0, recv_height: 720, available_incoming_kbps: 6000 })),
    ...f.nodeStart(),
    f.node(100, "sfu.source.lease_lost", "publisher", undefined, { source: "camera", cause: "expired", revision: 1 }),
  ];
  const silence = diagnose(rows).findings.find((finding) => finding.kind === "media_silence");
  assert.match(silence.cause, /lease was lost on the node \(expired\) while the Participant was still in the call/u);
  assert.equal(silence.side, "SFU");
});

test("a pause event about another publisher does not explain this viewer's silence", () => {
  const f = fixture();
  const other = { ...f.node(100, "sfu.subscription.paused", "viewer", "conn-view", { publisher_id: "participant-someone-else", source: "camera", media_kind: "video", mid: "9", reason: "congestion" }) };
  const rows = [...f.cast(), ...f.flow(), ...f.stats("viewer", "conn-view", 0, 300, () => ({ recv_bitrate_kbps: 0, recv_height: 720, available_incoming_kbps: 6000 })), ...f.nodeStart(), other];
  assert.doesNotMatch(diagnose(rows).findings.find((finding) => finding.kind === "media_silence").cause, /paused the subscription/u);
});

test("a viewer starved with no bandwidth estimate says the bandwidth was not measured and does not call the link healthy", () => {
  const result = diagnose(starvedWithoutNodeCall());
  const finding = result.findings.find((candidate) => candidate.kind === "starved_viewer");
  assert.match(finding.experience, /the downlink was not measured/u);
  assert.doesNotMatch(finding.experience, /healthy|clear/u);
  assert.ok(finding.notes.some((note) => /bandwidth not measured/u.test(note)));
  assert.match(finding.cause, /unknown: the SFU node logged no event for this connection/u);
  assert.equal(finding.side, "unknown");
  assert.ok(result.gaps.some((gap) => /bandwidth not measured for .*available_incoming_kbps/u.test(gap.what)));
  assert.ok(result.gaps.some((gap) => gap.blocks && gap.source === "sfu"));
  assert.match(result.verdict, /Missing sources: SFU node\./u);
});

test("a viewer starved on a measured-clear link is named with the node's bandwidth estimate", () => {
  const finding = diagnose(starvedViewerCall()).findings.find((candidate) => candidate.kind === "starved_viewer");
  assert.match(finding.experience, /26 kbps or less for \d+ s on a link that measured clear/u);
  assert.match(finding.cause, /bandwidth estimate for the viewer held the video down \(estimate 30 kbps/u);
  assert.equal(finding.side, "SFU");
});

test("an available bandwidth below the floor makes the link a poor one, and loss does too", () => {
  const congested = (extra) => starvedViewerCall().map((row) => (row.attributes?.event === "sdk.call_stats" ? { ...row, attributes: { ...row.attributes, ...extra } } : row));
  const [byBandwidth] = diagnose(congested({ available_incoming_kbps: 200 })).findings;
  assert.equal(byBandwidth.kind, "congested_viewer");
  assert.match(byBandwidth.cause, /200 kbps available at best/u);
  const [byLoss] = diagnose(congested({ recv_loss_pct: 9 })).findings;
  assert.equal(byLoss.kind, "congested_viewer");
  assert.match(byLoss.cause, /9% loss at worst/u);
});

test("the node's layer and a viewer pause are told apart when no bandwidth estimate was logged", () => {
  const without = (rows) => rows.filter((row) => row.attributes?.event !== "sfu.subscription.congestion");
  const layer = (name) => [...without(starvedViewerCall()), fixture("fz").node(25, "sfu.subscription.layer", "viewer", "conn-view", { publisher_id: "participant-publisher", source: "camera", media_kind: "video", mid: "0", layer: name })];
  const low = diagnose(layer("low")).findings.find((finding) => finding.kind === "starved_viewer");
  assert.match(low.cause, /forwarded layer low, below the highest/u);
  assert.equal(low.side, "SFU");
  assert.equal(diagnose(layer("high")).findings.find((finding) => finding.kind === "starved_viewer").side, "unknown");
});

test("audio the viewer could not hear is named by how far the track got, and by whose side owns the next step", () => {
  const finding = diagnose(stuckAudioCall()).findings.find((candidate) => candidate.kind === "audio_stuck");
  assert.equal(finding.participant, hashOf.viewer);
  assert.match(finding.experience, /could not hear the microphone for 20 s/u);
  assert.equal(finding.stage, "receiving");
  assert.equal(finding.side, "SFU");
  assert.match(finding.cause, /pulled but never arrived/u);
  const played = stuckAudioCall().map((row) => (row.attributes?.event === "sdk.connection_report" ? { ...row, attributes: { ...row.attributes, report: row.attributes.report.replace("pull_succeeded", "bytes_flowing") } } : row));
  assert.equal(diagnose(played).findings.find((candidate) => candidate.kind === "audio_stuck").side, "client");
});

test("a connection that was lost or ran out of recovery attempts is a finding that names the failing step", () => {
  const report = JSON.stringify({ trigger: "recovery_exhausted", events: [{ event: "media_recovery", outcome: "failed", media_error_step: "sfu_subscriptions", media_error_kind: "timeout" }] });
  const f = fixture();
  const [finding] = diagnose([f.api(40, "sdk.connection_report", "viewer", { trigger: "recovery_exhausted", report })]).findings;
  assert.equal(finding.kind, "connection_lost");
  assert.equal(finding.side, "SFU");
  assert.match(finding.cause, /timeout at sfu_subscriptions/u);
});

test("a connection replaced as dormant that the node never resumed is named as the cause of the silence, and the Participant comes from the connection", () => {
  const silence = diagnose(dormantReplacementCall()).findings.find((finding) => finding.kind === "media_silence");
  assert.equal(silence.participant, hashOf.viewer);
  assert.match(silence.cause, /replaced \(dormant_connection\)/u);
  assert.ok(silence.to - silence.from > thresholds.silence_ms);
  assert.match(diagnose(dormantReplacementCall()).verdict, /^Participant [0-9a-f]{8} received no media for \d+ s while a sender was sending from \d\d:\d\d:\d\d to \d\d:\d\d:\d\d UTC; failing stage: reconnecting, side: API; cause: the connection was replaced/u);
});

test("a pause counts only while no later resume or stop of the same subscription has ended it", () => {
  const cause = (name) => diagnose(scenarios[name]()).findings.find((finding) => finding.kind === "media_silence")?.cause ?? "";
  assert.match(cause("dormant replacement then silence"), /replaced/u);
  assert.doesNotMatch(cause("pause ended by a resume"), /paused the subscription/u);
  assert.doesNotMatch(cause("pause ended by a stop"), /paused the subscription/u);
  const open = fixture("fo");
  const rows = [...dormantReplacementCall(), open.node(100, "sfu.subscription.paused", "viewer", "conn-view-2", { publisher_id: "participant-publisher", source: "camera", media_kind: "video", mid: "0", reason: "congestion" })];
  const paused = diagnose(rows).findings.find((finding) => finding.kind === "media_silence");
  assert.match(paused.cause, /paused the subscription \(congestion\)/u);
  assert.equal(paused.side, "client");
});

test("a publisher whose sender reports 0 kbps while the viewer waits is the client's side, and the node's part is proved only when it logged", () => {
  const [finding] = diagnose(scenarios["publisher sent nothing"]()).findings;
  assert.deepEqual([finding.kind, finding.participant, finding.side], ["publisher_silent", hashOf.publisher, "client"]);
  assert.match(finding.cause, /accepted the publication/u);
  const f = fixture();
  const quiet = [...f.stats("publisher", "conn-pub", 0, 100, () => ({ send_bitrate_kbps: 0 })), ...f.stats("viewer", "conn-view", 0, 100, () => ({ recv_bitrate_kbps: 0 }))];
  const [bare] = diagnose(quiet).findings.filter((candidate) => candidate.kind === "publisher_silent");
  assert.match(bare.cause, /node's part is not proved/u);
  assert.deepEqual(kinds(diagnose(f.stats("publisher", "conn-pub", 0, 100, () => ({ send_bitrate_kbps: 0 })))), []);
});

test("a failed join names the API refusal that shares the report's journey id, else the failed step, else says unknown", () => {
  assert.match(diagnose(scenarios["failed join"]()).findings[0].cause, /episode\.full/u);
  const f = fixture();
  const events = [
    { event: "space_join_span", step: "access_initialize", outcome: "succeeded" },
    { event: "space_join_span", step: "wait_for_sync_live", outcome: "failed", code: "sync_start_failed", duration_ms: 30021 },
  ];
  const [step] = diagnose([f.api(5, "sdk.connection_report", "viewer", { trigger: "join_failed", report: JSON.stringify({ trigger: "join_failed", events }) })]).findings;
  assert.deepEqual([step.stage, step.side], ["joining", "Sync"]);
  assert.match(step.cause, /wait_for_sync_live \(sync_start_failed\) after 30 s/u);
  const [bare] = diagnose([f.api(5, "sdk.connection_report", "viewer", { trigger: "join_failed", report: "not json" })]).findings;
  assert.equal(bare.side, "unknown");
});

test("a replacement within 20 s of the join is flagged and one later is not", () => {
  assert.equal(diagnose(scenarios["replacement soon after join"]()).findings[0].kind, "early_replacement");
  const f = fixture();
  assert.deepEqual(diagnose([f.api(1, "http.request", "viewer", {}), f.api(60, "media.connection_replacement", "viewer", { replacement_cause: "access_refresh" })]).findings, []);
});

test("a receiver that never took media is flagged once the start has taken longer than the starved window, and not before", () => {
  const f = fixture();
  const receiver = (to) => [...f.flow(), ...f.stats("viewer", "conn-view", 0, to, () => ({ recv_bitrate_kbps: 0, recv_height: 640 }))];
  assert.deepEqual(diagnose(receiver(20)).findings, []);
  assert.deepEqual(kinds(diagnose(receiver(100))), ["media_silence"]);
});

test("a viewer that hid the video itself is a note, not a bad call, and without the field the same rows are silence", () => {
  const hidden = diagnose(scenarios["viewer hid the video itself"]());
  assert.deepEqual(
    hidden.findings.map((finding) => [finding.kind, finding.benign, finding.side]),
    [["viewer_hid_video", true, "client"]],
  );
  assert.match(hidden.verdict, /^Not enough evidence.*Participant [0-9a-f]{8} hid its own video.*by choice/u);
  const f = fixture();
  const plain = [...f.flow(), ...f.stats("viewer", "conn-view", 0, 300, (second) => ({ recv_bitrate_kbps: second < 20 ? 1200 : 0, recv_height: 720 }))];
  assert.equal(diagnose(plain).findings[0]?.kind, "media_silence");
});

test("every source row of a call is reached by an id, and the output says how many were", () => {
  const f = fixture();
  const rows = normalized([
    ...scenarios["clean call"](),
    f.node(120, "sfu.subscription.paused", "viewer", "conn-view", { reason: "viewer" }),
    f.api(7, "http.failure", "viewer", { journey_id: "journey-9" }),
    { _time: at(7), _rowId: "fx-j", "service.name": null, service: { name: "chalk-api" }, attributes: { event: "media.track_close", journey_id: "journey-9" } },
  ]);
  const result = joinByIds(EPISODE, rows);
  assertEveryRowJoined(result);
  for (const source of SOURCES) assert.ok(joinedShare(result.stats[source]) === 1, source);
  assert.ok(result.stats.api.journey >= 1, "the API line without an Episode id joined by journey id");
  const text = render({ ...diagnoseRows(EPISODE, rows), elapsedMs: 1234 });
  assert.match(text, /^VERDICT: /mu);
  assert.match(text, /Rows by source: client \d+, api \d+, sync \d+, sfu \d+, recorder 0, db \d+/u);
  assert.match(text, /Elapsed: 1\.2 s$/u);
});

test("a source row that names no id fails the join check, and a row of another call is neither joined nor lost", () => {
  const f = fixture();
  const lost = normalizeRow(f.node(50, "sfu.subscription.layer", "viewer", undefined, { layer: "low", connection_id: undefined, episode_id: undefined, participant_id: undefined }));
  const other = normalizeRow(f.node(5, "sfu.session.registered", "viewer", "conn-other", { episode_id: "other-episode" }));
  const result = joinByIds(EPISODE, [...normalized(scenarios["clean call"]()), lost, other]);
  assert.equal(result.unjoined.length, 1);
  assert.throws(() => assertEveryRowJoined(result), /sfu:sfu\.subscription\.layer/u);
  assert.ok(!result.joined.some((row) => row.connection === "conn-other"));
});

test("the report shows a summary, a timeline per Participant with stage, side and row ids, and the missing data last", () => {
  const text = render({ ...diagnose(neverConnectedCall()), elapsedMs: 0 });
  const order = ["VERDICT:", "Summary", "Participant 153be25c (publisher)", "Participant 3c7e85ea (viewer)", "Missing data"].map((heading) => text.indexOf(heading));
  assert.ok(order.every((at) => at >= 0) && order.toSorted((a, b) => a - b).join() === order.join(), text);
  assert.match(text, /▶ 10:00:02 {2}connecting {2}unknown {2}had no media path.*\[fx-\d{4}, fx-\d{4}/u);
  assert.match(text, /\[blocks the verdict\] no API rows|no sdk\.call_stats rows/u);
});

/** The query bodies a fake Axiom received, and rows it answers with. */
function fakeAxiom(answer) {
  const queries = [];
  const fetchImpl = async (_url, { body }) => {
    const { apl } = JSON.parse(body);
    queries.push(apl);
    return { ok: true, status: 200, json: async () => ({ matches: answer(apl) }), text: async () => "" };
  };
  return { fetchImpl, queries };
}
const env = { AXIOM_TOKEN: "token", CHALK_LOG_DATASET: "logs", CHALK_TRACE_DATASET: "traces", AXIOM_ORG_ID: "org" };
const noDatabase = async () => ({ rows: [], gaps: [] });
const read = (overrides) => readSources({ episodeId: EPISODE, env, windowDays: 14, readDb: noDatabase, ...overrides });
const matchOf = (row) => ({ _time: row._time, _rowId: row._rowId, data: row });

test("a source that runs past the deadline is a blocking gap and the others are still read", async () => {
  const hang = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  const { rows, gaps } = await read({ fetchImpl: hang, deadlineMs: 50 });
  assert.deepEqual(rows, []);
  assert.match(gaps.map((gap) => gap.what).join("\n"), /log dataset could not be read \(the 0\.05 s deadline passed\)/u);
  assert.ok(gaps.every((gap) => gap.blocks || gap.source === "sync"));
});

test("a query that returns the row cap is a gap and not a silent cut", async () => {
  const flood = Array.from({ length: ROW_CAP }, (_, index) => matchOf({ _time: at(index % 60), _rowId: `flood-${index}`, attributes: { event: "sdk.call_stats", episode_id: EPISODE } }));
  const { fetchImpl } = fakeAxiom((apl) => (apl.includes("episode_id") ? flood : []));
  const { gaps } = await read({ fetchImpl });
  assert.ok(gaps.some((gap) => gap.blocks && /returned its row cap/u.test(gap.what)));
});

test("rows named by a connection id are looked up by connection_id and by provider_session_id, in chunks of at most 100", async () => {
  const rows = scenarios["clean call"]().filter((row) => row.attributes?.event === "sdk.call_stats");
  const { fetchImpl, queries } = fakeAxiom((apl) => (apl.includes("episode_id") ? rows.map(matchOf) : []));
  await read({ fetchImpl });
  const byConnection = queries.filter((apl) => apl.includes("provider_session_id"));
  assert.ok(byConnection.length > 0, "no query by provider_session_id");
  assert.ok(byConnection.every((apl) => apl.includes("connection_id") && (apl.match(/'conn-/gu) ?? []).length <= 100));
});

test("Sync is a visible blocking gap when the trace dataset is not set, and the database window is the one the thresholds name", async () => {
  const { fetchImpl } = fakeAxiom(() => []);
  const { gaps } = await read({ fetchImpl, env: { ...env, CHALK_TRACE_DATASET: undefined } });
  assert.ok(gaps.some((gap) => gap.source === "sync" && gap.blocks && /CHALK_TRACE_DATASET is not set/u.test(gap.what)));
  const windows = [];
  await read({ fetchImpl, now: T0, readDb: async ({ since }) => (windows.push(since), { rows: [], gaps: [] }) });
  assert.deepEqual(windows, [T0 - 14 * 86_400_000]);
  assert.match(episodeSql(EPISODE, T0 - 14 * 86_400_000), /created_at >= '2026-10-28T10:00:00\.000Z'::timestamptz/u);
});

test("the database URL reaches psql through its environment and never its arguments, and the session is read-only", async () => {
  const url = "postgresql://reader:s3cret-value@db.example.test:5432/chalk?sslmode=verify-full";
  const settings = connectionEnv(url, { PATH: "/usr/bin", HOME: "/home/x", AXIOM_TOKEN: "must-not-pass" });
  assert.deepEqual([settings.PGHOST, settings.PGUSER, settings.PGPASSWORD, settings.PGDATABASE, settings.PGSSLMODE], ["db.example.test", "reader", "s3cret-value", "chalk", "verify-full"]);
  assert.equal(settings.AXIOM_TOKEN, undefined);
  assert.match(settings.PGOPTIONS, /default_transaction_read_only=on/u);

  const directory = await mkdtemp(join(tmpdir(), "diagnose-call-"));
  await writeFile(join(directory, "psql"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${directory}/argv"\nprintf '%s\\n' '{"_rowId":"db:episodes:9feb0ff6","_time":"${at(0)}","event":"db.episode","episode_id":"${EPISODE}"}'\n`);
  await chmod(join(directory, "psql"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${directory}:${path}`;
  try {
    const result = await readDatabase({ url, episodeId: EPISODE, since: T0 - 86_400_000, signal: AbortSignal.timeout(10_000) });
    assert.equal(result.rows.length, 1);
  } finally {
    process.env.PATH = path;
  }
  const argv = await readFile(join(directory, "argv"), "utf8");
  assert.doesNotMatch(argv, /s3cret-value|db\.example\.test|postgresql:/u);
  const none = await readDatabase({ url: undefined, episodeId: EPISODE, since: T0 });
  assert.ok(none.gaps[0].blocks && /CHALK_DATABASE_URL is not set/u.test(none.gaps[0].what));
});

test("--strict fails on a bad call, then on missing evidence, and passes a clean call; the usage names every variable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "diagnose-call-"));
  const exit = async (name, ...flags) => {
    const file = join(directory, `${name.replaceAll(" ", "-")}.json`);
    await writeFile(file, JSON.stringify(scenarios[name]()));
    return run("node", [new URL("./index.mjs", import.meta.url).pathname, EPISODE, "--fixture", file, ...flags]).then(
      () => 0,
      (error) => error.code,
    );
  };
  assert.equal(await exit("never connected with peer states", "--strict"), 3);
  assert.equal(await exit("missing sources", "--strict"), 2);
  assert.equal(await exit("clean call", "--strict"), 0);
  assert.equal(await exit("never connected with peer states"), 0);
  const usage = await run("node", [new URL("./index.mjs", import.meta.url).pathname]).catch((error) => error);
  assert.equal(usage.code, 64);
  for (const name of ["AXIOM_TOKEN", "AXIOM_ORG_ID", "CHALK_LOG_DATASET", "CHALK_TRACE_DATASET", "CHALK_DATABASE_URL"]) assert.match(usage.stderr, new RegExp(name, "u"));
  assert.equal(strictCode({ findings: [], gaps: [{ blocks: false }] }), 0);
});

test("the fixtures hold no production identifier: every id is invented", () => {
  const text = JSON.stringify(Object.values(scenarios).map((build) => build()));
  assert.doesNotMatch(text, /52730039|479a5f5e|688d874b|6b0f58f2|ff75a37c|3a47f23d-[0-9a-f]{4}/u);
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-(?!444455556666|000000000001)[0-9a-f]{12}/u);
});

test("the checker reads the same thresholds the file names, with no dead setting", () => {
  assert.deepEqual(Object.keys(thresholds).toSorted(), ["available_floor_kbps", "early_replacement_ms", "healthy_loss_pct", "healthy_rtt_ms", "leave_slack_ms", "silence_ms", "starved_floor_kbps", "starved_ms", "window_days"]);
});

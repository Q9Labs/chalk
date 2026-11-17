import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseRows, thresholds } from "./index.mjs";
import { EPISODE, dormantReplacementCall, fixture, hashOf, neverConnectedCall, scenarios, starvedViewerCall, starvedWithoutNodeCall, stuckAudioCall } from "./scenarios.mjs";
import { render } from "./render.mjs";
import { normalizeRow } from "./rows.mjs";

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

test("the summary names the media plane and who chose it when the database or the API logged it, and says nothing when neither did", () => {
  const rows = scenarios["clean call"]();
  assert.doesNotMatch(render({ ...diagnose(rows), elapsedMs: 0 }), /Media plane/u);
  const episode = rows.find((row) => row.event === "db.episode");
  const chosen = rows.map((row) => (row === episode ? { ...row, media_plane_provider: "chalk_sfu", media_plane_selected_by: "space_setting" } : row));
  const result = diagnose(chosen);
  assert.equal(result.plane.selectedBy, "space_setting");
  assert.match(render({ ...result, elapsedMs: 0 }), /Media plane: chalk_sfu, chosen by space_setting \[db:episodes:/u);
  const event = fixture("fx-plane").api(-4, "media_plane.selected", undefined, { provider: "chalk_sfu", selected_by: "kill_switch" });
  assert.equal(diagnose([...rows, event]).plane.selectedBy, "kill_switch");
  assert.equal(
    diagnose([...rows, event]).timeline.episode.some((step) => step.text.startsWith("the API chose the media plane")),
    true,
  );
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

import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseRows, strictCode } from "./index.mjs";
import { render } from "./render.mjs";
import { normalizeRow } from "./rows.mjs";
import { EPISODE, fixture, neverConnectedCall, scenarios } from "./scenarios.mjs";
import { durableOnlyCall, planeChangeCall, recoveredDropCall } from "./scenarios-sfu.mjs";

const diagnose = (rows, gaps = []) =>
  diagnoseRows(
    EPISODE,
    rows.map((row) => normalizeRow(row)),
    gaps,
  );
const kind = (result, name) => result.findings.find((finding) => finding.kind === name);

/** The same call with the node's closing line for the viewer replaced by `attributes`. */
const closedWith = (attributes) => neverConnectedCall().map((row) => (row.attributes?.event === "sfu.session.closed" ? { ...row, attributes: { ...row.attributes, ...attributes } } : row));

test("a drop the connection recovered from on its own is a recovered drop with its length, and it does not fail the call", () => {
  const result = diagnose(recoveredDropCall());
  const drop = kind(result, "recovered_drop");
  assert.ok(drop.benign);
  assert.match(drop.experience, /lost its media path for 10 s at 10:01:30 UTC and recovered without rejoining/u);
  assert.equal(strictCode(result), 0);
  assert.match(result.verdict, /recovered on its own/u);
});

test("a retried session create is not a new session: only the first registration of a connection can be a rejoin", () => {
  const f = fixture();
  const early = f.node(80, "sfu.session.registered", "publisher", "conn-pub-2", { allocation: 2 });
  const retry = f.node(95, "sfu.session.registered", "publisher", "conn-pub-2", { allocation: 2 });
  const result = diagnose([...recoveredDropCall(), early, retry]);
  assert.ok(kind(result, "recovered_drop"));
  assert.equal(kind(result, "drop_needed_rejoin"), undefined);
});

test("a recovery during which another Participant had to start a new session fails the 10 s criterion", () => {
  const result = diagnose(recoveredDropCall({ rejoin: true }));
  const drop = kind(result, "drop_needed_rejoin");
  assert.ok(!drop.benign && !kind(result, "recovered_drop"));
  assert.match(drop.notes.join("\n"), /1 other Participants started a new session while it was down/u);
  assert.equal(strictCode(result), 3);
});

test("the node's outcome names the fault: a session that never connected is never_connected whatever closed it, and dropped, failed and interrupted are their own", () => {
  const never = kind(diagnose(closedWith({ cause: "removed", outcome: "never_connected" })), "never_connected");
  assert.match(never.cause, /closed never_connected.*\(closed by removed\)|never_connected/u);
  assert.match(kind(diagnose(closedWith({ cause: "removed", outcome: "dropped" })), "dropped").experience, /lost its media path and did not get it back/u);
  assert.match(kind(diagnose(closedWith({ cause: "removed", outcome: "failed" })), "negotiation_failed").cause, /could not apply an offer or answer/u);
  assert.equal(kind(diagnose(closedWith({ cause: "node_shutdown", outcome: "interrupted" })), "node_shutdown").side, "SFU");
  assert.equal(
    diagnose(closedWith({ cause: "removed", outcome: "left" })).findings.some((finding) => ["never_connected", "dropped", "negotiation_failed", "node_shutdown"].includes(finding.kind)),
    false,
  );
});

test("a failed control call to the node is the node's fault on a 5xx and the request's on a 4xx", () => {
  const f = fixture();
  const failure = (status) => diagnose([...scenarios["clean call"](), f.node(50, "sfu.control.failed", "viewer", "conn-view", { operation: "subscribe", status, code: "problem" })]);
  assert.equal(kind(failure(503), "control_failed").side, "SFU");
  assert.equal(kind(failure(409), "control_failed").side, "API");
  const gone = diagnose([...scenarios["clean call"](), f.node(50, "sfu.control.failed", "viewer", "conn-view", { operation: "close_tracks", status: 404, code: "session_gone" })]);
  assert.equal(
    gone.findings.some((one) => one.kind === "control_failed"),
    false,
  );
  const lost = diagnose([...scenarios["clean call"](), f.node(50, "sfu.control.failed", "viewer", "conn-view", { operation: "add_tracks", status: 404, code: "session_gone" })]);
  assert.equal(kind(lost, "control_failed").side, "API");
});

test("the durable outcome of a call Axiom no longer holds is read: a session that ended while down, and a recovery known by its total", () => {
  const result = diagnose(durableOnlyCall());
  const dropped = kind(result, "dropped");
  assert.match(dropped.cause, /closed \(removed\) while the connection was down after 298 s/u);
  assert.match(dropped.notes.join("\n"), /durable outcome saved with the Participant is the proof/u);
  assert.match(dropped.notes.join("\n"), /down 41 s in 1 drop/u);
  const recovered = kind(result, "recovered_drop");
  assert.ok(recovered.benign);
  assert.match(recovered.experience, /2 times \(14 s in all\)/u);
  assert.match(recovered.cause, /only the durable total is kept/u);
  assert.ok(result.gaps.some((gap) => gap.source === "sfu" && gap.blocks && /durable outcome of its media sessions was read/u.test(gap.what)));
  assert.equal(strictCode(result), 3);
});

test("a session with a node line and a durable row is one finding that cites the node's line", () => {
  const f = fixture();
  const durable = f.db(62, "db.media_session", "media_session:conn-view", { participant_id: "participant-viewer", generation: 1, connection_id: "conn-view", cause: "never_connected", outcome: "never_connected", connected: false, lifetime_ms: 60_000, disconnects: 0, outage_ms: 0 });
  const result = diagnose([...neverConnectedCall(), durable]);
  const found = result.findings.filter((finding) => finding.kind === "never_connected");
  assert.equal(found.length, 1);
  assert.ok(found[0].proof.ids.some((id) => id.startsWith("fx-")));
  assert.doesNotMatch(found[0].notes.join("\n"), /durable outcome saved with the Participant is the proof/u);
});

test("the plane the Episode got and each change to a plane setting while it ran are in the summary", () => {
  const result = diagnose(planeChangeCall());
  assert.equal(result.plane.selectedBy, "space");
  assert.equal(result.plane.changes.length, 1);
  const text = render({ ...result, elapsedMs: 0 });
  assert.match(text, /Media plane: chalk_sfu, chosen by space/u);
  assert.match(text, /Plane change during the Episode: at 10:02:00 UTC the space setting went from chalk_sfu to cf_sfu \(operator-1: rollback of the new media plane\)/u);
  assert.equal(diagnose(scenarios["clean call"]()).plane, undefined);
});

test("rows the node should have exported and did not are missing data that names the counter and the gauge to check", () => {
  const f = fixture();
  const durable = f.db(301, "db.media_session", "media_session:conn-view", { participant_id: "participant-viewer", generation: 1, connection_id: "conn-view", cause: "removed", outcome: "left", connected: true, lifetime_ms: 299_000, connect_ms: 900, disconnects: 0, outage_ms: 0 });
  const text = diagnose([...scenarios["clean call"](), durable])
    .gaps.map((gap) => gap.what)
    .join("\n");
  assert.match(text, /durable outcome but no sfu\.session\.closed line.*chalk\.sfu\.telemetry\.dropped.*logs_export/u);
  assert.match(text, /no sfu\.media\.\* stats rows.*chalk\.sfu\.telemetry\.dropped/u);
});

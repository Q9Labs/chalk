// Fake calls in the shape the real sources return: Axiom rows keep a nested `service` and `attributes` beside flat dotted
// keys that are null, and carry a long tail of null attributes; node events name the raw Participant id and a
// `<incarnation>.<hex>` connection id; database rows are what database.mjs selects. Every id and value here is invented.
import { participantHash } from "./rows.mjs";

export const EPISODE = "9feb0ff6-1111-4222-8333-444455556666";
export const T0 = Date.parse("2026-11-11T10:00:00Z");
const TENANT = "00000000-0000-4000-8000-000000000001";
const RAW = { publisher: "participant-publisher", viewer: "participant-viewer" };
export const hashOf = { publisher: participantHash(RAW.publisher), viewer: participantHash(RAW.viewer) };

export const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();

/** The null-filled attributes every real log row carries, so a reader that trusts the first key it finds would misread the row. */
const NOISE = { actor_id: null, address: null, cause: null, code: null, connection_id: null, error_code: null, exception: { message: null, type: null }, reason: null, session: { id: null }, state: null, status: null, trace_id: null };

/** One fake call's rows. A fresh fixture numbers its rows from 1, so a row id in a finding names the same row on every run. */
export function fixture(prefix = "fx") {
  let counter = 0;
  const id = () => `${prefix}-${String(++counter).padStart(4, "0")}`;
  const axiom = (service, seconds, event, attributes) => ({
    _time: at(seconds),
    _rowId: id(),
    "attributes.event": null,
    "attributes.provider": null,
    "service.name": null,
    service: { name: service, version: "0.0.0-fixture" },
    body: event,
    attributes: { ...NOISE, event, ...attributes },
  });
  const api = (seconds, event, who, attributes = {}) => axiom("chalk-api", seconds, event, { episode_id: EPISODE, participant_id_hash: hashOf[who], provider: "chalk_sfu", ...attributes });
  /** An SFU node event: the node logs the raw Participant id, never a hash. */
  const node = (seconds, event, who, connection, attributes = {}) => axiom("chalk-sfu", seconds, event, { tenant_id: TENANT, episode_id: EPISODE, participant_id: RAW[who], connection_id: connection, generation: 1, session_kind: "participant", node_incarnation: "3a47f23d", ...attributes });
  const sync = (seconds, name, who) => ({ _time: at(seconds), _rowId: id(), "service.name": null, resource: { service: { name: "chalk-sync" } }, name, attributes: { custom: { episode_id: EPISODE, participant_id_hash: hashOf[who] } } });
  const db = (seconds, event, key, fields) => ({ _rowId: `db:${key}`, _time: at(seconds), event, episode_id: EPISODE, ...fields });
  const stats = (who, connection, from, to, fields) => {
    const rows = [];
    for (let second = from; second < to; second += 10) {
      rows.push(api(second + 10, "sdk.call_stats", who, { connection_id: connection, provider_session_id: connection, elapsed_ms: (second + 10) * 1000, window_ms: 10_000, rtt_ms: 40, recv_loss_pct: 0, ...fields(second) }));
    }
    return rows;
  };
  const viewing = (fields) => stats("viewer", "conn-view", 0, 300, fields);
  const healthyViewing = () => viewing(() => ({ recv_bitrate_kbps: 1400, recv_height: 720, available_incoming_kbps: 6000 }));
  /** Video that falls from 1200 kbps to 26 kbps after 20 s. */
  const starvedViewing = (height, extra = {}) => viewing((second) => ({ recv_bitrate_kbps: second < 20 ? 1200 : 26, recv_height: height, ...extra }));
  const flow = (connection = "conn-pub") => stats("publisher", connection, 0, 300, () => ({ send_bitrate_kbps: 1500 }));
  /** The Episode, its two Participants and the Sync sockets, as the database and Sync hold them. */
  const cast = ({ viewerConnection = "conn-view", viewerLeft = 300, viewerLeaveReason = "left" } = {}) => [
    db(-5, "db.episode", "episodes:9feb0ff6", { status: "ended", started_at: at(-5), ended_at: at(310), end_reason: "ended" }),
    db(-2, "db.participant", "participants:pub00001", { participant_id: RAW.publisher, role: "publisher", status: "left", generation: 1, joined_at: at(-2), left_at: at(300), last_left_reason: "left", connection_id: "conn-pub" }),
    db(-1, "db.participant", "participants:view0001", {
      participant_id: RAW.viewer,
      role: "viewer",
      status: viewerLeft ? "left" : "joined",
      generation: 1,
      joined_at: at(-1),
      left_at: viewerLeft ? at(viewerLeft) : null,
      last_left_reason: viewerLeft ? viewerLeaveReason : null,
      connection_id: viewerConnection,
    }),
    api(-2, "http.request", "publisher", { status: 200, route: "/v1/episodes/join" }),
    api(-1, "http.request", "viewer", { status: 200, route: "/v1/episodes/join" }),
    sync(-2, "sync.participant.socket_up", "publisher"),
    sync(-1, "sync.participant.socket_up", "viewer"),
  ];
  /** The node's view of a healthy start: sessions registered, the publication accepted, the subscription started. */
  const nodeStart = (viewerConnection = "conn-view") => [
    node(0, "sfu.session.registered", "publisher", "conn-pub", { allocation: 1 }),
    node(1, "sfu.publication.started", "publisher", "conn-pub", { source: "camera", media_kind: "video" }),
    node(2, "sfu.session.registered", "viewer", viewerConnection, { allocation: 1 }),
    node(3, "sfu.subscription.started", "viewer", viewerConnection, { publisher_id: RAW.publisher, source: "camera", media_kind: "video", mid: "0" }),
  ];
  /** What the node writes every 10 s for a connected session. `fields(second)` gives the counters of the row written at that second. */
  const every = (from, to, build) => Array.from({ length: Math.floor((to - from) / 10) + 1 }, (_, step) => build(from + step * 10)).flat();
  /** The publisher's video track as the node receives it (`sfu.media.ingress`). Counters are cumulative. */
  const uplink = (who, connection, from, to, fields) =>
    every(from, to, (second) =>
      node(second, "sfu.media.ingress", who, connection, { source: "camera", media_kind: "video", mid: "0", packets: second * 100, bytes: second * 100_000, lost: 0, repaired: 0, jitter_ms: 3, bitrate_bps: 1_500_000, layers: 3, layers_active: 3, held: false, ...fields(second) }),
    );
  /** What the subscriber's own reports say of the video the node sends it (`sfu.media.egress`). */
  const downlink = (who, connection, from, to, fields) =>
    every(from, to, (second) => node(second, "sfu.media.egress", who, connection, { media_kind: "video", subscriptions: 1, paused_subscriptions: 0, high_layer: 0, low_layer: 1, loss_share: 0, rtt_ms: 40, jitter_ms: 5, bitrate_bps: 26_000, ...fields(second) }));
  /** The send side of the subscriber's session (`sfu.media.transport`). */
  const sendSide = (who, connection, from, to, fields) => every(from, to, (second) => node(second, "sfu.media.transport", who, connection, { estimate_bps: 5_000_000, proven_bps: 4_000_000, queued_bytes: 0, feedback_age_ms: 50, dropped: 0, repairs_cut: 0, ...fields(second) }));
  return { api, node, sync, db, stats, flow, cast, nodeStart, healthyViewing, starvedViewing, uplink, downlink, sendSide };
}

const subscription = { publisher_id: RAW.publisher, source: "camera", media_kind: "video", mid: "0" };

export function dormantReplacementCall() {
  const f = fixture();
  return [
    ...f.cast({ viewerConnection: "conn-view-2" }),
    ...f.flow(),
    ...f.stats("viewer", "conn-view", 0, 100, () => ({ recv_bitrate_kbps: 1400, recv_height: 720, available_incoming_kbps: 6000 })),
    // The real replacement row names the new connection and no Participant.
    f.api(100, "media.connection_replacement", "viewer", { participant_id_hash: null, connection_id: "conn-view-2", replacement_cause: "dormant_connection" }),
    ...f.stats("viewer", "conn-view-2", 100, 300, (second) => ({ recv_bitrate_kbps: second < 160 ? 0 : 1400, recv_height: 720, available_incoming_kbps: 6000 })),
    ...f.nodeStart("conn-view"),
    f.node(100, "sfu.session.registered", "viewer", "conn-view-2", { allocation: 1 }),
  ];
}

/** The node paused the viewer's video at 100 s and then resumed or detached that subscription at 110 s, so the pause is over when the silence ends. */
const pausedCall = (ending) => {
  const f = fixture("fy");
  return [...dormantReplacementCall(), f.node(100, "sfu.subscription.paused", "viewer", "conn-view-2", { ...subscription, reason: "congestion" }), f.node(110, ending, "viewer", "conn-view-2", subscription)];
};

/** A viewer held at 26 kbps on a measured-clear link while the node's estimate for it was low. */
export function starvedViewerCall() {
  const f = fixture();
  return [
    ...f.cast(),
    ...f.flow(),
    ...f.starvedViewing(180, { available_incoming_kbps: 6000 }),
    ...f.nodeStart(),
    // The congestion line still exports camelCase names.
    f.node(25, "sfu.subscription.congestion", "viewer", "conn-view", { mid: "0", layer: "low", reason: "estimate", estimateBps: 30_000, deliveredShare: 0.4, lossShare: 0 }),
  ];
}

/** The 40-minute call's shape: a starved viewer, a publisher sending, and no SFU rows and no bandwidth estimate at all. */
export function starvedWithoutNodeCall() {
  const f = fixture();
  return [...f.cast(), ...f.flow(), ...f.starvedViewing(480)];
}

/** The viewer's session never found a media path: ICE only ever checked, and the node closed it after 60 s. The lease expired with no leave. */
export function neverConnectedCall({ withPeerStates = true } = {}) {
  const f = fixture();
  return [
    ...f.cast({ viewerLeft: 0 }),
    ...f.flow(),
    f.node(0, "sfu.session.registered", "publisher", "conn-pub", { allocation: 1 }),
    f.node(2, "sfu.session.registered", "viewer", "conn-view", { allocation: 1 }),
    ...(withPeerStates ? [f.node(3, "sfu.ice.state", "viewer", "conn-view", { state: "checking" })] : []),
    f.node(62, "sfu.session.closed", "viewer", "conn-view", { cause: "never_connected", lifetime_ms: 60_000, publications: 0, subscriptions: 0 }),
    f.db(70, "db.journey_event", "journey:conn0001", { journey_name: "participant.connection_expired", journey_id: "journey-expired", trace_id: "trace-expired", participant_id_hash: hashOf.viewer, expiry_path: "lease_sweep", last_seen_age_ms: 65_000 }),
  ];
}

/** The viewer was told the audio track was pulled, and no sound came: the report names how far the receive got. */
export function stuckAudioCall() {
  const f = fixture();
  const report = JSON.stringify({ trigger: "audio_receive_stuck", events: [{ event: "audio_receive_stuck", source: "microphone", receive_state: "pull_succeeded", duration_ms: 20_000, media_error_kind: "unknown" }] });
  return [...f.cast(), ...f.flow(), ...f.healthyViewing(), ...f.nodeStart(), f.api(60, "sdk.connection_report", "viewer", { connection_id: "conn-view", trigger: "audio_receive_stuck", report })];
}

/** Every source answered, media flowed, and the publisher's lease was revoked as it left: cleanup, not a fault. */
function healthyCall() {
  const f = fixture();
  return [
    ...f.cast(),
    ...f.flow(),
    ...f.healthyViewing(),
    ...f.nodeStart(),
    f.node(300, "sfu.source.lease_lost", "publisher", undefined, { source: "camera", cause: "revoked", revision: 1 }),
    f.node(301, "sfu.session.closed", "publisher", "conn-pub", { cause: "removed", lifetime_ms: 301_000, publications: 1, subscriptions: 0 }),
  ];
}

/** Only the client logged anything: the database, the node and Sync were not read. */
function missingSourcesCall() {
  const f = fixture();
  return [...f.flow(), ...f.stats("viewer", "conn-view", 0, 300, () => ({ recv_bitrate_kbps: 1400, recv_height: 720 }))];
}

function failedJoinCall() {
  const f = fixture();
  return [f.api(5, "sdk.connection_report", "viewer", { trigger: "join_failed", journey_id: "journey-1" }), f.api(5, "http.request", "viewer", { status: 403, error_code: "episode.full", journey_id: "journey-1" })];
}

function earlyReplacementCall() {
  const f = fixture();
  return [f.api(1, "http.request", "viewer", {}), f.api(13, "media.connection_replacement", "viewer", { replacement_cause: "access_refresh" })];
}

/** A viewer whose tab hid the video receives nothing on purpose; the rule must not call that silence or starvation. */
function hiddenByViewerCall() {
  const f = fixture();
  return [...f.flow(), ...f.stats("viewer", "conn-view", 0, 300, (second) => ({ recv_bitrate_kbps: second < 20 ? 1200 : 0, recv_height: 720, recv_hidden_videos: second < 20 ? 0 : 1 }))];
}

/** The publisher's sender reports 0 kbps from the start while the viewer waits: the node accepted the publication and nothing came. */
function silentPublisherCall() {
  const f = fixture();
  return [
    ...f.stats("publisher", "conn-pub", 0, 300, () => ({ send_bitrate_kbps: 0 })),
    ...f.stats("viewer", "conn-view", 0, 300, () => ({ recv_bitrate_kbps: 0, recv_height: 720 })),
    f.node(0, "sfu.session.registered", "publisher", "conn-pub"),
    f.node(1, "sfu.publication.started", "publisher", "conn-pub", { source: "camera", media_kind: "video" }),
    f.node(3, "sfu.subscription.started", "viewer", "conn-view", subscription),
  ];
}

const CLEAR_LINK = { recv_bitrate_kbps: 1200, recv_loss_pct: 0, rtt_ms: 40, available_incoming_kbps: 6000 };
const CONGESTED_LINK = { recv_bitrate_kbps: 60, recv_loss_pct: 11, rtt_ms: 420, available_incoming_kbps: 250 };

/** A viewer whose downlink lost packets and queued: the bitrate fell to a trickle while the node and the publisher were fine. */
function congestedViewerCall() {
  const f = fixture();
  return [...f.flow(), ...f.stats("viewer", "conn-view", 0, 300, (second) => ({ recv_height: 360, ...(second < 20 ? CLEAR_LINK : CONGESTED_LINK) })), f.node(0, "sfu.session.registered", "viewer", "conn-view")];
}

/** A viewer that never took any media while a sender was sending: the start never finished. */
function neverReceivedCall() {
  const f = fixture();
  return [...f.flow(), ...f.stats("viewer", "conn-view", 0, 100, () => ({ recv_bitrate_kbps: 0, recv_height: 640 }))];
}

/** The viewer's connection dropped for 10 s at 90 s and connected again with the same session; with `rejoin`, the publisher had to start a new session meanwhile. */
export function recoveredDropCall({ rejoin = false } = {}) {
  const f = fixture();
  return [
    ...f.cast(),
    ...f.flow(),
    ...f.healthyViewing(),
    ...f.nodeStart(),
    f.node(90, "sfu.peer.state", "viewer", "conn-view", { state: "disconnected" }),
    f.node(100, "sfu.peer.state", "viewer", "conn-view", { state: "connected", outage_ms: 10_000 }),
    ...(rejoin ? [f.node(95, "sfu.session.registered", "publisher", "conn-pub-2", { allocation: 2 })] : []),
    f.node(301, "sfu.session.closed", "viewer", "conn-view", { cause: "removed", outcome: "left", connected: true, lifetime_ms: 299_000, connect_ms: 800, disconnects: 1, outage_ms: 10_000, publications: 0, subscriptions: 1 }),
  ];
}

/** A viewer starved from 20 s on, with the publisher's uplink clean. `link` says which leg lost the packets. */
function starvedOnLeg(link) {
  const f = fixture();
  const late = (second, value) => (second >= 20 ? value : 0);
  const uplink = {
    clean: (second) => ({ packets: second * 100 }),
    // Packets still missing rise and then fall as a late repair arrives, so `lost` is not monotonic.
    repaired: (second) => ({ packets: second * 100, lost: second % 30 === 0 ? 4 : 0, repaired: Math.floor(second / 30) * 4 }),
    lossy: (second) => ({ packets: second * 100, lost: late(second, (second - 10) * 4), jitter_ms: late(second, 45) }),
  }[link.uplink];
  return [
    ...f.cast(),
    ...f.flow(),
    ...f.starvedViewing(180, { available_incoming_kbps: 6000 }),
    ...f.nodeStart(),
    ...f.uplink("publisher", "conn-pub", 10, 300, uplink),
    ...f.downlink("viewer", "conn-view", 10, 300, (second) => ({ loss_share: late(second, link.loss), rtt_ms: late(second, link.rtt) || 40 })),
    ...(link.transport ? f.sendSide("viewer", "conn-view", 10, 300, (second) => ({ dropped: late(second, (second - 10) * link.dropped) })) : []),
  ];
}
/** The node's pacer dropped the viewer's video; the loss is at the node. */
export const nodeDroppingCall = () => starvedOnLeg({ uplink: "clean", loss: 0.06, rtt: 60, transport: true, dropped: 4 });
/** The viewer's own reports show loss and a long round trip, the node dropped nothing, and the publisher's late repairs make `lost` fall. */
export const downlinkLossCall = () => starvedOnLeg({ uplink: "repaired", loss: 0.09, rtt: 380, transport: true, dropped: 0 });
/** The publisher's uplink lost packets and jittered while the node dropped nothing. */
export const uplinkLossCall = () => starvedOnLeg({ uplink: "lossy", loss: 0, rtt: 40, transport: true, dropped: 0 });
/** The same downlink loss with no transport row, so the node's own drops are not known. */
export const downlinkWithoutTransportCall = () => starvedOnLeg({ uplink: "clean", loss: 0.09, rtt: 380, transport: false, dropped: 0 });

/** The publisher unmuted its microphone at 100, 120 and 140 s; each pair is the first leg (held to first voiced) and the second (voiced to first forwarded) in milliseconds, and the call is muted once at 200 s. */
export function unmuteCall(legs) {
  const f = fixture();
  const audio = { publisher_id: RAW.publisher, source: "microphone", media_kind: "audio", mid: "1" };
  return [
    ...f.cast(),
    ...f.flow(),
    ...f.healthyViewing(),
    ...f.nodeStart(),
    f.node(4, "sfu.subscription.started", "viewer", "conn-view", audio),
    ...legs.flatMap(([voiced, forwarded], index) => {
      const held = 100 + index * 20;
      const key = { source: "microphone", unmute_seq: index + 1 };
      return [
        f.node(held, "sfu.publication.held", "publisher", "conn-pub", { ...key, media_kind: "audio", held: false }),
        f.node(held + voiced / 1000, "sfu.unmute.first_voiced", "publisher", "conn-pub", { ...key, since_unmute_ms: voiced }),
        f.node(held + (voiced + forwarded) / 1000, "sfu.unmute.first_forwarded", "viewer", "conn-view", { ...audio, ...key, since_voiced_ms: forwarded, since_unmute_ms: voiced + forwarded }),
      ];
    }),
    f.node(200, "sfu.publication.held", "publisher", "conn-pub", { source: "microphone", media_kind: "audio", held: true, unmute_seq: legs.length }),
  ];
}
/** Every unmute reached the viewer within the 2250 ms budget. */
export const unmuteWithinBudgetCall = () =>
  unmuteCall([
    [400, 80],
    [900, 120],
    [1100, 150],
  ]);
/** The third unmute took 2700 ms to reach the viewer, 1900 ms of it on the node's own forwarding leg. */
export const unmuteOverBudgetCall = () =>
  unmuteCall([
    [400, 80],
    [900, 120],
    [800, 1900],
  ]);

/** An Episode older than Axiom's retention: only the database rows exist. The viewer's session ended while down, the publisher's recovered from two drops. */
export function durableOnlyCall() {
  const f = fixture();
  const session = (who, connection, fields) => f.db(300, "db.media_session", `media_session:${connection}`, { participant_id: RAW[who], generation: 1, connection_id: connection, cause: "removed", connected: true, lifetime_ms: 298_000, connect_ms: 900, ...fields });
  return [...f.cast().filter((row) => row.event?.startsWith("db.")), session("viewer", "conn-view", { outcome: "dropped", disconnects: 1, outage_ms: 41_000 }), session("publisher", "conn-pub", { outcome: "left", disconnects: 2, outage_ms: 14_000 })];
}

/** The Space's plane setting changed while the Episode ran; the Episode kept the plane it was bound to. */
export function planeChangeCall() {
  const f = fixture();
  return [
    ...f.cast().map((row) => (row.event === "db.episode" ? { ...row, media_plane_provider: "chalk_sfu", media_plane_selected_by: "space" } : row)),
    ...f.flow(),
    ...f.healthyViewing(),
    ...f.nodeStart(),
    f.db(120, "db.media_plane_change", "media_plane_change:7", { scope: "space", old_plane: "chalk_sfu", new_plane: "cf_sfu", actor: "operator-1", reason: "rollback of the new media plane" }),
  ];
}

/** Every scenario the rules must name, as raw rows. */
export const scenarios = {
  "dormant replacement then silence": dormantReplacementCall,
  "viewer starved with node rows": starvedViewerCall,
  "viewer starved without node rows": starvedWithoutNodeCall,
  "never connected with peer states": neverConnectedCall,
  "never connected without peer states": () => neverConnectedCall({ withPeerStates: false }),
  "stuck audio": stuckAudioCall,
  "clean call": healthyCall,
  "missing sources": missingSourcesCall,
  "failed join": failedJoinCall,
  "replacement soon after join": earlyReplacementCall,
  "viewer hid the video itself": hiddenByViewerCall,
  "publisher sent nothing": silentPublisherCall,
  "congested viewer": congestedViewerCall,
  "receiver never took media": neverReceivedCall,
  "pause ended by a resume": () => pausedCall("sfu.subscription.resumed"),
  "pause ended by a stop": () => pausedCall("sfu.subscription.stopped"),
  "recovered drop": recoveredDropCall,
  "recovered drop with a rejoin": () => recoveredDropCall({ rejoin: true }),
  "viewer starved by the node's pacer": nodeDroppingCall,
  "viewer starved by its downlink": downlinkLossCall,
  "viewer starved by the publisher's uplink": uplinkLossCall,
  "viewer starved by its downlink without a transport row": downlinkWithoutTransportCall,
  "unmutes within budget": unmuteWithinBudgetCall,
  "unmute over budget": unmuteOverBudgetCall,
  "durable outcome without Axiom rows": durableOnlyCall,
  "plane setting changed during the call": planeChangeCall,
};

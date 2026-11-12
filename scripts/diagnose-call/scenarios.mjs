// Raw rows, shaped as Axiom returns them, for the calls the verdict has to name.
import { participantHash } from "./rows.mjs";

export const EPISODE = "9feb0ff6-1111-4222-8333-444455556666";
export const T0 = Date.parse("2026-11-11T10:00:00Z");
const publisher = "participant-publisher";
const viewer = "participant-viewer";
export const hashOf = { publisher: participantHash(publisher), viewer: participantHash(viewer) };

export const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();

/** An API log line, shaped as Axiom returns it. */
export const api = (seconds, event, who, attributes = {}) => ({
  _time: at(seconds),
  "service.name": "chalk-api",
  attributes: { event, episode_id: EPISODE, participant_id_hash: hashOf[who], provider: "chalk_sfu", ...attributes },
});

/** An SFU node event: it names the connection and the raw Participant id, never a hash. */
const node = (seconds, event, who, connection, attributes = {}) => ({
  _time: at(seconds),
  "service.name": "chalk-sfu",
  attributes: { event, episode_id: EPISODE, participant_id: who === "publisher" ? publisher : viewer, connection_id: connection, ...attributes },
});

/** One sdk.call_stats row per sample, as the API logs them, every ten seconds from `from` to `to`. */
export function callStats(who, connection, from, to, fields) {
  const rows = [];
  for (let second = from; second < to; second += 10) {
    rows.push(api(second + 10, "sdk.call_stats", who, { connection_id: connection, provider_session_id: connection, elapsed_ms: (second + 10) * 1000, window_ms: 10_000, rtt_ms: 40, recv_loss_pct: 0, ...fields(second) }));
  }
  return rows;
}

export const flow = (publisherConnection) => callStats("publisher", publisherConnection, 0, 300, () => ({ send_bitrate_kbps: 1500 }));

export function dormantReplacementCall() {
  return [
    ...flow("conn-pub"),
    ...callStats("viewer", "conn-view", 0, 100, () => ({ recv_bitrate_kbps: 1400, recv_height: 720 })),
    api(100, "media.connection_replacement", "viewer", { connection_id: "conn-view-2", replacement_cause: "dormant_connection" }),
    ...callStats("viewer", "conn-view-2", 100, 300, (second) => ({ recv_bitrate_kbps: second < 160 ? 0 : 1400, recv_height: 720 })),
    node(0, "sfu.session.registered", "publisher", "conn-pub"),
    node(2, "sfu.session.registered", "viewer", "conn-view"),
    node(3, "sfu.subscription.started", "viewer", "conn-view"),
    node(100, "sfu.session.registered", "viewer", "conn-view-2"),
  ];
}

export function starvedViewerCall() {
  return [
    ...flow("conn-pub"),
    ...callStats("viewer", "conn-view", 0, 300, (second) => ({ recv_bitrate_kbps: second < 20 ? 1200 : 26, recv_height: 180, available_incoming_kbps: 6000 })),
    node(0, "sfu.session.registered", "viewer", "conn-view"),
    node(20, "sfu.subscription.layer", "viewer", "conn-view", { layer: "low", ceiling: "high", server_limit: "low" }),
  ];
}

function failedJoinCall() {
  const journey = "journey-1";
  return [api(5, "sdk.connection_report", "viewer", { trigger: "join_failed", journey_id: journey }), api(5, "http.failure", "viewer", { error_code: "episode.full", journey_id: journey })];
}

function earlyReplacementCall() {
  return [api(1, "http.request", "viewer", {}), api(13, "media.connection_replacement", "viewer", { replacement_cause: "access_refresh" })];
}

function healthyCall() {
  return [...flow("conn-pub"), ...callStats("viewer", "conn-view", 0, 300, () => ({ recv_bitrate_kbps: 1400, recv_height: 720 }))];
}

/** A viewer whose tab hid the video receives nothing on purpose; the rule must not call that silence or starvation. */
function hiddenByViewerCall() {
  return [...flow("conn-pub"), ...callStats("viewer", "conn-view", 0, 300, (second) => ({ recv_bitrate_kbps: second < 20 ? 1200 : 0, recv_height: 720, recv_hidden_videos: second < 20 ? 0 : 1 }))];
}

/** The publisher's sender reports 0 kbps from the start while the viewer waits: the node accepted the publication and nothing came. */
function silentPublisherCall() {
  return [
    ...callStats("publisher", "conn-pub", 0, 300, () => ({ send_bitrate_kbps: 0 })),
    ...callStats("viewer", "conn-view", 0, 300, () => ({ recv_bitrate_kbps: 0, recv_height: 720 })),
    node(0, "sfu.session.registered", "publisher", "conn-pub"),
    node(1, "sfu.publication.started", "publisher", "conn-pub"),
    node(3, "sfu.subscription.started", "viewer", "conn-view"),
  ];
}

const CLEAR_LINK = { recv_bitrate_kbps: 1200, recv_loss_pct: 0, rtt_ms: 40, available_incoming_kbps: 6000 };
const CONGESTED_LINK = { recv_bitrate_kbps: 60, recv_loss_pct: 11, rtt_ms: 420, available_incoming_kbps: 250 };

/** A viewer whose downlink lost packets and queued: the bitrate fell to a trickle while the node and the publisher were fine. */
function congestedViewerCall() {
  return [
    ...flow("conn-pub"),
    ...callStats("viewer", "conn-view", 0, 300, (second) => ({ recv_height: 360, ...(second < 20 ? CLEAR_LINK : CONGESTED_LINK) })),
    node(0, "sfu.session.registered", "viewer", "conn-view"),
    node(20, "sfu.subscription.layer", "viewer", "conn-view", { layer: "low", ceiling: "high", server_limit: "high" }),
  ];
}

/** Every scenario the verdict rules must name, as raw rows. The Go collector reads the same file, so the two implementations agree. */
export const scenarios = {
  "dormant replacement then silence": dormantReplacementCall,
  "viewer starved on a healthy link": starvedViewerCall,
  "failed join": failedJoinCall,
  "replacement soon after join": earlyReplacementCall,
  "healthy call": healthyCall,
  "viewer hid the video itself": hiddenByViewerCall,
  "publisher sent nothing": silentPublisherCall,
  "congested viewer": congestedViewerCall,
};

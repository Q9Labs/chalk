// Fake calls for what the SFU telemetry and the media plane record: session outcomes, media stats, unmute legs, the durable session
// table and plane changes. Same row shapes as scenarios.mjs, and every id and value is invented.
import { RAW, fixture } from "./scenarios.mjs";

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

/** The scenarios that cover the SFU telemetry, as raw rows. */
export const sfuScenarios = {
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

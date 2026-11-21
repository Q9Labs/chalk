// @ts-check
/**
 * video.low_quality: a viewer's camera tile is a picture but degraded — never broken, degraded only.
 *
 * The witnesses are in areas/video.json — the viewer witnesses plus `video.egress`, `video.transport` and
 * `video.congestion` for downlink attribution. Degraded means: the tile surface sat in paused_for_network or
 * frozen_frame, or a sustained window where received video bitrate stayed under the quality floor with the send
 * layer capped or the SFU plan on lowest/paused, while the tile was on screen.
 *
 * Hop attribution: a subscription.congestion reason (bandwidth, layer_loss, capacity, livelock) puts it at
 * sfu_forward; transport drops with estimate below proven put it at subscriber_downlink; a send_layer cap or a
 * quality_limitation_reason on the publisher's own send puts it at client_encode; the SFU's plan lowest/paused with
 * pause_reason=congestion puts it at sfu_forward.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "video.low_quality";

/** Received video bitrate under this (bps) while a picture shows reads degraded. */
const LOW_BITRATE_BPS = 150_000;
/** The stretch a low-bitrate window must hold before it counts. */
const SUSTAIN_MS = 15_000;
const FLOW_GAP_MS = 35_000;

export const expected = "a shown camera tile keeps a healthy bitrate and a non-degraded surface; a pause the viewer or the SFU's plan caused is expected";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

const byTime = (a, b) => a.window.from_ms - b.window.from_ms;
const num = (v) => (typeof v === "number" ? v : Number(v));

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const tile = readings["video.tile"];
  const call = readings["video.call_window"];
  const forwarded = readings["video.forwarded"];
  const congestion = readings["video.congestion"];
  const transport = readings["video.transport"];
  const probe = readings["video.render_probe"];
  const connection = readings["video.connection"];

  const needed = { "video.tile": tile, "video.call_window": call, "video.forwarded": forwarded, "video.congestion": congestion, "video.transport": transport };
  const missing = Object.entries(needed).find(([, r]) => r.kind !== "present");
  if (missing) return { status: "unknown", reason: `${missing[0]} has no present witness` };

  const conn = connection.kind === "present" ? [...connection.observations].sort(byTime).at(-1) : null;
  if (conn && ["reconnecting", "leaving", "left", "failed"].includes(conn.claim)) return { status: "unknown", reason: `the seat is ${conn.claim}` };

  const tiles = [...tile.observations].sort(byTime);
  const pictured = tiles.some((o) => o.claim === "picture") || (probe.kind === "present" && probe.observations.some((o) => num(o.value.presented_frames) > 0));
  const degradedTile = tiles.find((o) => o.claim === "paused_for_network" || o.claim === "frozen_frame");

  const windows = [...call.observations].sort(byTime).filter((o) => o.value.gap === undefined || o.value.gap === null || o.value.gap === "");
  const lowWindows = windows.filter((o) => num(o.value.recv_bitrate_bps) > 0 && num(o.value.recv_bitrate_bps) < LOW_BITRATE_BPS);
  const sustained = lowWindows.length > 0 && lowWindows[lowWindows.length - 1].window.from_ms - lowWindows[0].window.from_ms >= SUSTAIN_MS;

  const cameraForward = forwarded.observations.filter((o) => o.value.source === "camera").sort(byTime);
  const cappedPlan = cameraForward.find((o) => o.value.plan === "lowest" || o.value.plan === "paused" || o.value.pause_reason === "congestion");
  const congestionRow = congestion.kind === "present" ? [...congestion.observations].sort(byTime).find((o) => o.claim) : null;
  const transportRow = transport.kind === "present" ? [...transport.observations].sort(byTime).find((o) => num(o.value.dropped) > 0) : null;

  if (!pictured) return { status: "pass" };
  if (!degradedTile && !sustained && !cappedPlan) return { status: "pass" };

  // Hop: congestion view first (the SFU's own cause), then the transport's drop history, then the plan.
  let hop = "sfu_forward";
  let module = "sfu.media";
  let observed = "the SFU ran a lowered plan or paused the subscription for congestion";
  if (!congestionRow && transportRow && num(transportRow.value.dropped) > 0 && num(transportRow.value.estimate_bps) < num(transportRow.value.proven_bps)) {
    hop = "subscriber_downlink";
    module = "network";
    observed = "the viewer's downlink dropped packets and the estimate sits below proven";
  } else if (!congestionRow && !cappedPlan && sustained) {
    hop = "subscriber_downlink";
    module = "network";
    observed = `received video stayed under ${LOW_BITRATE_BPS / 1000} kbps for ${Math.round((lowWindows[lowWindows.length - 1].window.from_ms - lowWindows[0].window.from_ms) / 1000)} s`;
  }

  const window = degradedTile?.window ?? { from_ms: lowWindows[0]?.window.from_ms ?? cameraForward[0]?.window.from_ms ?? 0, to_ms: lowWindows.at(-1)?.window.to_ms ?? cappedPlan?.window.to_ms ?? 0 };

  return {
    status: "finding",
    outcome: "degraded",
    window,
    hop,
    module,
    reason: null,
    upstream: "witnessed",
    observed,
    facts: [
      ...(degradedTile ? [{ text: `tile ${degradedTile.claim}`, evidence: [degradedTile.id], window: degradedTile.window, absent: null }] : []),
      ...lowWindows.slice(-2).map((o) => ({ text: `recv_bitrate_bps=${o.value.recv_bitrate_bps}`, evidence: [o.id], window: o.window, absent: null })),
      ...(cappedPlan ? [{ text: `plan=${cappedPlan.value.plan} pause_reason=${cappedPlan.value.pause_reason ?? "none"}`, evidence: [cappedPlan.id], window: cappedPlan.window, absent: null }] : []),
      ...(congestionRow ? [{ text: `congestion reason=${congestionRow.claim}`, evidence: [congestionRow.id], window: congestionRow.window, absent: null }] : []),
      ...(transportRow ? [{ text: `transport dropped=${transportRow.value.dropped} estimate_bps=${transportRow.value.estimate_bps}`, evidence: [transportRow.id], window: transportRow.window, absent: null }] : []),
    ],
    hypothesis: { text: `the link degraded at ${hop}`, falsified_by: "the tile returning to picture at full bitrate" },
    falsify: { absence: null, attribution: "bitrate above the floor without a capped plan" },
  };
}

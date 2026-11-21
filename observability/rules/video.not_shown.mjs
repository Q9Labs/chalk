// @ts-check
/**
 * video.not_shown: a viewer's camera tile never showed a picture for a bound publisher.
 *
 * The witnesses are in areas/video.json: `video.render_probe`, `video.tile`, `video.track_window`, `video.call_window`,
 * `video.forwarded` and `video.viewer_pause` are required; `video.stats_failed`, `video.connection` corroborate.
 *
 * The failing hop is the first link where delivery stopped: sfu_forward when forwarded packets never flowed;
 * subscriber_downlink when the SFU forwarded but the viewer's track counters stayed flat; client_decode when packets
 * arrived but frames_decoded stayed flat; client_render when decoded frames arrived but the tile never showed a
 * picture and the probes say it was on screen.
 *
 * EXPECTED with video.viewer_hidden when an open pause explains it (subscription paused reason=viewer, or the probes
 * say the tile was off-screen, page hidden or covered), and video.reconnecting when the reconnect clause holds.
 * A native tile can't prove rendering: probe_unavailable=native_render reads unknown, never healthy.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "video.not_shown";

const FLOW_GROWTH = 50;
const FLOW_GAP_MS = 35_000;
const STALL_MS = 20_000;
const RECONNECT_GRACE_MS = 10_000;

export const expected = "a bound camera picture reaches the tile: the SFU forwards it, the decoder grows frames, and the surface shows picture or a probe sees presented frames";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

const byTime = (a, b) => a.window.from_ms - b.window.from_ms;
const num = (v) => (typeof v === "number" ? v : Number(v));

function flowVerdict(rows, field) {
  const ordered = [...rows].sort(byTime);
  let prev = null;
  let firstRow = null;
  for (const o of ordered) {
    if (firstRow === null) firstRow = o;
    if (prev !== null) {
      const gap = o.window.from_ms - prev.window.from_ms;
      if (gap <= FLOW_GAP_MS && num(o.value[field]) - num(prev.value[field]) >= FLOW_GROWTH) return { state: "flowing", at: o.window.from_ms, last: o };
    }
    prev = o;
  }
  const last = ordered[ordered.length - 1];
  if (firstRow && num(firstRow.value[field]) === 0 && last && last.window.from_ms - firstRow.window.from_ms >= STALL_MS) return { state: "not_flowing", at: firstRow.window.from_ms, last };
  return { state: "not_flowing", at: last?.window.from_ms ?? 0, last };
}

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const probe = readings["video.render_probe"];
  const tile = readings["video.tile"];
  const track = readings["video.track_window"];
  const call = readings["video.call_window"];
  const forwarded = readings["video.forwarded"];
  const pause = readings["video.viewer_pause"];
  const statsFailed = readings["video.stats_failed"];
  const connection = readings["video.connection"];

  const needed = { "video.render_probe": probe, "video.tile": tile, "video.track_window": track, "video.call_window": call, "video.forwarded": forwarded, "video.viewer_pause": pause };
  const missing = Object.entries(needed).find(([, r]) => r.kind !== "present");
  if (missing) return { status: "unknown", reason: `${missing[0]} has no present witness` };

  const probes = [...probe.observations].sort(byTime);
  if (probes.some((o) => o.value.probe_unavailable === "native_render")) {
    return { status: "unknown", reason: "no render probe (unavailable(native_render))" };
  }
  if (probes.length === 0) return { status: "unknown", reason: "no render probe" };

  const conn = connection.kind === "present" ? [...connection.observations].sort(byTime).at(-1) : null;
  if (conn && ["reconnecting", "leaving", "left", "failed"].includes(conn.claim)) return { status: "unknown", reason: `the seat is ${conn.claim}` };

  const tiles = [...tile.observations].sort(byTime);
  const pictured = tiles.some((o) => o.claim === "picture") || probes.some((o) => num(o.value.presented_frames) > 0 && o.value.on_screen === true);
  if (pictured) return { status: "pass" };

  // Find the publisher this seat watches: any forwarded/pause row's publisher_id; when there is none the check has
  // nothing to blame and stays unknown rather than inventing a black tile.
  const pubs = new Set([...forwarded.observations, ...pause.observations].map((o) => o.value.publisher_id).filter((v) => typeof v === "string"));
  if (pubs.size === 0) return { status: "unknown", reason: "no camera subscription is witnessed for this seat" };

  // An open pause explains a missing picture: reason=viewer means the viewer asked; congestion/source_inactive name
  // the SFU's cause. A covered or hidden tile is the same witness from the client side.
  const pauseRows = [...pause.observations].sort(byTime);
  const openPause = pauseRows.filter((o) => (o.claim === "viewer" || o.claim === "congestion" || o.claim === "source_inactive") && !pauseRows.some((n) => n.claim !== "stopped" && n.window.from_ms > o.window.from_ms && n.value.was === o.claim));
  const hidden = probes.some((o) => o.value.on_screen === false || o.value.page_visible === false || o.value.covered === true);

  if (openPause.some((o) => o.claim === "viewer") || (hidden && !openPause.some((o) => o.claim === "congestion"))) {
    return {
      status: "finding",
      outcome: "expected",
      window: probes[probes.length - 1].window,
      hop: "client_render",
      module: "react.tile",
      reason: "video.viewer_hidden",
      upstream: "witnessed",
      observed: "the tile is hidden, covered or the page is hidden; the subscription pause is the viewer's own request",
      facts: [
        ...probes.slice(-2).map((o) => ({ text: `probe on_screen=${o.value.on_screen} page_visible=${o.value.page_visible} covered=${o.value.covered}`, evidence: [o.id], window: o.window, absent: null })),
        ...pauseRows.filter((o) => o.claim === "viewer").slice(-1).map((o) => ({ text: `subscription paused reason=viewer for ${o.value.publisher_id}`, evidence: [o.id], window: o.window, absent: null })),
      ],
      hypothesis: { text: "the viewer hid the tile", falsified_by: "a probe showing the tile on screen while the subscription stayed paused" },
      falsify: { absence: null, attribution: "a visible uncovered tile with no picture" },
    };
  }

  // First failed hop: walk the chain from the SFU out.
  const cameraForward = forwarded.observations.filter((o) => o.value.source === "camera");
  const fwd = flowVerdict(cameraForward, "forwarded_packets");
  const cameraTracks = track.observations.filter((o) => o.value.source === "camera");
  const trk = flowVerdict(cameraTracks, "packets");
  const dec = flowVerdict(cameraTracks, "frames_decoded");

  let hop, module, observed;
  if (fwd.state !== "flowing") {
    hop = "sfu_forward";
    module = "sfu.media";
    observed = "the SFU never forwarded flowing packets for the camera subscription";
  } else if (trk.state !== "flowing") {
    hop = "subscriber_downlink";
    module = "network";
    observed = "the SFU forwarded the camera but the viewer's inbound track stayed flat";
  } else if (dec.state !== "flowing") {
    hop = "client_decode";
    module = "sdk.media";
    observed = "packets reached the viewer but frames_decoded stayed flat";
  } else {
    hop = "client_render";
    module = "react.tile";
    observed = "decoded frames arrived but the tile never showed a picture";
  }

  const publisher = [...pubs].join(",");
  const lastFwd = fwd.last ?? cameraForward[cameraForward.length - 1];
  const window = { from_ms: fwd.at || probes[0].window.from_ms, to_ms: (lastFwd?.window.to_ms ?? probes[probes.length - 1].window.to_ms) };

  return {
    status: "finding",
    outcome: "broken",
    window,
    hop,
    module,
    reason: null,
    upstream: "witnessed",
    observed: `${observed} (publisher ${publisher})`,
    facts: [
      ...cameraForward.slice(-2).map((o) => ({ text: `forwarded_packets=${o.value.forwarded_packets} for ${o.value.publisher_id}`, evidence: [o.id], window: o.window, absent: null })),
      ...cameraTracks.slice(-2).map((o) => ({ text: `track ${o.value.mid} packets=${o.value.packets} frames_decoded=${o.value.frames_decoded}`, evidence: [o.id], window: o.window, absent: null })),
      ...probes.slice(-2).map((o) => ({ text: `probe presented_frames=${o.value.presented_frames} on_screen=${o.value.on_screen}`, evidence: [o.id], window: o.window, absent: null })),
    ],
    hypothesis: { text: `delivery stopped at ${hop}`, falsified_by: "growth of ≥50 on the first flat counter, or the tile showing a picture" },
    falsify: { absence: null, attribution: "flow on the next link downstream, or an open pause explaining the stop" },
  };
}

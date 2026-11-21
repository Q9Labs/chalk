// @ts-check
/**
 * video.frozen: a viewer's camera tile shows a picture but presented_frames stops growing while packets arrive.
 *
 * The witnesses are in areas/video.json — the same as video.not_shown. The freeze judgement is on the viewer's own
 * probes: two probes at least 8 s apart, both on screen and page-visible, with no presented_frames growth between
 * them, while the inbound track's packets grew at least 50 in the window. A probe gap over 7 s is an unmeasured
 * stretch, not a black tile.
 *
 * The hop is the first link that stopped: sfu_forward when forwarded_packets stopped; subscriber_downlink when the
 * track's packets stopped; client_decode when packets grew but frames_decoded did not; client_render when decoded
 * frames grew but presented_frames did not.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "video.frozen";

const FLOW_GROWTH = 50;
const FLOW_GAP_MS = 35_000;
const PROBE_MIN_APART_MS = 8_000;
const PROBE_GAP_UNMEASURED_MS = 7_000;
const RECONNECT_GRACE_MS = 10_000;

export const expected = "a shown camera tile's presented_frames keeps growing while packets arrive; a hidden tile, an open pause or a reconnect stretch the picture matched inside 10 s are expected";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

const byTime = (a, b) => a.window.from_ms - b.window.from_ms;
const num = (v) => (typeof v === "number" ? v : Number(v));

function grew(rows, field, fromMs, toMs) {
  const inWindow = rows.filter((o) => o.window.from_ms >= fromMs && o.window.from_ms <= toMs).sort(byTime);
  for (let i = 1; i < inWindow.length; i++) {
    const gap = inWindow[i].window.from_ms - inWindow[i - 1].window.from_ms;
    if (gap <= FLOW_GAP_MS && num(inWindow[i].value[field]) - num(inWindow[i - 1].value[field]) >= FLOW_GROWTH) return true;
  }
  return false;
}

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const probe = readings["video.render_probe"];
  const tile = readings["video.tile"];
  const track = readings["video.track_window"];
  const forwarded = readings["video.forwarded"];
  const pause = readings["video.viewer_pause"];
  const connection = readings["video.connection"];

  const needed = { "video.render_probe": probe, "video.tile": tile, "video.track_window": track, "video.forwarded": forwarded, "video.viewer_pause": pause };
  const missing = Object.entries(needed).find(([, r]) => r.kind !== "present");
  if (missing) return { status: "unknown", reason: `${missing[0]} has no present witness` };

  const probes = [...probe.observations].sort(byTime);
  if (probes.some((o) => o.value.probe_unavailable === "native_render")) return { status: "unknown", reason: "no render probe (unavailable(native_render))" };
  if (probes.length === 0) return { status: "unknown", reason: "no render probe" };

  const conn = connection.kind === "present" ? [...connection.observations].sort(byTime).at(-1) : null;
  if (conn && ["reconnecting", "leaving", "left", "failed"].includes(conn.claim)) return { status: "unknown", reason: `the seat is ${conn.claim}` };

  // The tile must have shown a picture once for a freeze to mean anything.
  const tiles = [...tile.observations].sort(byTime);
  const shownAt = probes.findIndex((o) => num(o.value.presented_frames) > 0 && o.value.on_screen === true);
  const everShown = tiles.some((o) => o.claim === "picture") || shownAt >= 0;
  if (!everShown) return { status: "pass" };

  // Freeze stretch: two on-screen visible probes >=8 s apart with no presented_frames growth.
  let frozen = null;
  for (let i = 0; i < probes.length; i++) {
    const a = probes[i];
    if (!(a.value.on_screen === true && a.value.page_visible === true && a.value.covered !== true)) continue;
    for (let j = i + 1; j < probes.length; j++) {
      const b = probes[j];
      const apart = b.window.from_ms - a.window.from_ms;
      if (apart > PROBE_GAP_UNMEASURED_MS && apart < PROBE_MIN_APART_MS) break;
      if (apart < PROBE_MIN_APART_MS) continue;
      if (b.value.on_screen !== true || b.value.page_visible !== true || b.value.covered === true) break;
      if (num(b.value.presented_frames) - num(a.value.presented_frames) === 0) { frozen = { from: a, to: b }; break; }
    }
    if (frozen) break;
  }
  if (!frozen) return { status: "pass" };

  const cameraTracks = track.observations.filter((o) => o.value.source === "camera");
  const cameraForward = forwarded.observations.filter((o) => o.value.source === "camera");
  const fromMs = frozen.from.window.from_ms;
  const toMs = frozen.to.window.from_ms;

  // Reconnect clause.
  if (connection.kind === "present") {
    const rows = [...connection.observations].sort(byTime);
    const rec = rows.find((o) => o.claim === "reconnecting" && o.window.from_ms <= fromMs && o.value.trigger !== "receive_stalled");
    if (rec) {
      const recovered = rows.find((o) => o.claim === "live" && o.window.from_ms >= rec.window.from_ms);
      const back = probes.find((o) => num(o.value.presented_frames) > num(frozen.from.value.presented_frames) && (!recovered || o.window.from_ms - recovered.window.from_ms <= RECONNECT_GRACE_MS));
      if (recovered && back) return { status: "pass" };
    }
  }

  const pauseRows = [...pause.observations].sort(byTime);
  const openPause = pauseRows.find((o) => ["viewer", "congestion", "source_inactive"].includes(o.claim) && o.window.from_ms <= toMs && !pauseRows.some((n) => n.window.from_ms > o.window.from_ms && n.value.was === o.claim));
  if (openPause?.claim === "viewer") {
    return {
      status: "finding",
      outcome: "expected",
      window: { from_ms: fromMs, to_ms: toMs },
      hop: "client_render",
      module: "react.tile",
      reason: "video.viewer_hidden",
      upstream: "witnessed",
      observed: "presented frames stopped while the subscription was paused at the viewer's request",
      facts: [
        { text: "subscription paused reason=viewer", evidence: [openPause.id], window: openPause.window, absent: null },
        { text: `probes ${num(frozen.to.value.presented_frames) - num(frozen.from.value.presented_frames)} new presented frames over ${Math.round((toMs - fromMs) / 1000)} s`, evidence: [frozen.from.id, frozen.to.id], window: { from_ms: fromMs, to_ms: toMs }, absent: null },
      ],
      hypothesis: { text: "the viewer's own pause stopped the frames", falsified_by: "the tile rendering frames while paused" },
      falsify: { absence: null, attribution: "frames presenting while the pause was open" },
    };
  }

  const packetsGrew = grew(cameraTracks, "packets", fromMs, toMs);
  const decodedGrew = grew(cameraTracks, "frames_decoded", fromMs, toMs);
  const forwardedGrew = grew(cameraForward, "forwarded_packets", fromMs, toMs);

  let hop, module, observed;
  if (!forwardedGrew && cameraForward.length > 0) {
    hop = "sfu_forward";
    module = "sfu.media";
    observed = "the SFU stopped forwarding while the tile was up";
  } else if (!packetsGrew && cameraTracks.length > 0) {
    hop = "subscriber_downlink";
    module = "network";
    observed = "the inbound track's packets stopped while the tile was up";
  } else if (packetsGrew && !decodedGrew) {
    hop = "client_decode";
    module = "sdk.media";
    observed = "packets kept arriving but frames_decoded stopped";
  } else if (packetsGrew) {
    hop = "client_render";
    module = "react.tile";
    observed = "decoded frames grew but presented_frames did not";
  } else {
    return { status: "unknown", reason: "no flow witness covers the frozen stretch" };
  }

  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: fromMs, to_ms: toMs },
    hop,
    module,
    reason: null,
    upstream: "witnessed",
    observed: `${observed} over ${Math.round((toMs - fromMs) / 1000)} s`,
    facts: [
      { text: `probes ${Math.round((toMs - fromMs) / 1000)} s apart, presented_frames flat at ${frozen.from.value.presented_frames}`, evidence: [frozen.from.id, frozen.to.id], window: { from_ms: fromMs, to_ms: toMs }, absent: null },
      ...cameraTracks.slice(-2).map((o) => ({ text: `track ${o.value.mid} packets=${o.value.packets} decoded=${o.value.frames_decoded}`, evidence: [o.id], window: o.window, absent: null })),
      ...cameraForward.slice(-2).map((o) => ({ text: `forwarded_packets=${o.value.forwarded_packets}`, evidence: [o.id], window: o.window, absent: null })),
    ],
    hypothesis: { text: `delivery stalled at ${hop}`, falsified_by: "presented_frames growth inside the stretch" },
    falsify: { absence: null, attribution: "presented_frames growth, or a hidden/covered tile during the stretch" },
  };
}

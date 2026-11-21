// @ts-check
/**
 * video.not_published: the publisher's camera reached `live` with a bound publication, but the SFU never saw flowing
 * packets on its ingress.
 *
 * The witnesses are in areas/video.json: `video.camera_state`, `video.send_window`, `video.ingress` and
 * `video.publication` are required; `video.call_window`, `video.stats_failed`, `video.source_lease`,
 * `video.connection` corroborate.
 *
 * Flowing means an ingress row's `packets` grew at least 50 over a gap of at most 35 s from the previous row for the
 * same track. Not flowing means growth below 50, or a first row with packets=0 followed by no flowing row for 20 s.
 *
 * Hop assignment: the send window's frames_encoded growing while ingress stays flat puts the stop at publisher_uplink
 * (network); frames_encoded flat or every layer inactive puts it at client_encode (sdk.media). A publication.started
 * row never landing puts it at publisher_uplink. A lease_lost with no later lease_opened for camera excludes the
 * finding; a stats_failed leaves the send side unknown.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "video.not_published";

const FLOW_GROWTH = 50;
const FLOW_GAP_MS = 35_000;
const STALL_MS = 20_000;

export const expected = "the camera reaching live+bound puts flowing packets on the SFU's ingress: growth of at least 50 over gaps of at most 35 s";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

const byTime = (a, b) => a.window.from_ms - b.window.from_ms;
const num = (v) => (typeof v === "number" ? v : Number(v));

/**
 * Flow judgement over cumulative-counter rows for one track: growth >= 50 over a <=35 s gap is flowing; growth below
 * that, or a first row with 0 packets that no flowing row follows inside 20 s, is not.
 * @param {readonly (import("../../scripts/diagnose-call/proof/evidence.mjs").Observation)[]} rows
 */
function flowVerdict(rows, field) {
  const ordered = [...rows].sort(byTime);
  let prev = null;
  let firstRow = null;
  for (const o of ordered) {
    if (firstRow === null) firstRow = o;
    if (prev !== null) {
      const gap = o.window.from_ms - prev.window.from_ms;
      const growth = num(o.value[field]) - num(prev.value[field]);
      if (gap <= FLOW_GAP_MS && growth >= FLOW_GROWTH) return { state: "flowing", at: o.window.from_ms, last: o };
    }
    prev = o;
  }
  const last = ordered[ordered.length - 1];
  if (firstRow && num(firstRow.value[field]) === 0 && last && last.window.from_ms - firstRow.window.from_ms >= STALL_MS) return { state: "not_flowing", at: firstRow.window.from_ms, last };
  return { state: "not_flowing", at: last?.window.from_ms ?? 0, last };
}

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const camera = readings["video.camera_state"];
  const send = readings["video.send_window"];
  const ingress = readings["video.ingress"];
  const publication = readings["video.publication"];
  const lease = readings["video.source_lease"];
  const statsFailed = readings["video.stats_failed"];
  const connection = readings["video.connection"];

  if (camera.kind !== "present" || send.kind !== "present" || ingress.kind !== "present" || publication.kind !== "present") {
    return { status: "unknown", reason: "a required witness for the publish path is missing" };
  }
  const cameraRows = [...camera.observations].sort(byTime);
  const liveRow = [...cameraRows].reverse().find((o) => o.claim === "live" && o.value.camera_bound === true);
  if (!liveRow) return { status: "pass" };
  const at = liveRow.window.from_ms;

  const conn = connection.kind === "present" ? [...connection.observations].sort(byTime).at(-1) : null;
  if (conn && ["reconnecting", "leaving", "left", "failed"].includes(conn.claim)) return { status: "unknown", reason: `the seat is ${conn.claim}` };

  const cameraIngress = ingress.observations.filter((o) => o.value.source === "camera" && o.value.media_kind === "video");
  const leaseLost = lease.kind === "present" && lease.observations.some((o) => o.claim === "camera" && o.value.cause === "revoked" && !lease.observations.some((n) => n.claim === "camera" && n.window.from_ms > o.window.from_ms && n.value.cause === undefined));
  if (leaseLost) return { status: "pass" };

  const ingressFlow = flowVerdict(cameraIngress, "packets");
  if (ingressFlow.state === "flowing") return { status: "pass" };

  const layers = [...send.observations].sort(byTime);
  const encoded = layers.filter((o) => num(o.value.frames_encoded) > 0 || o.value.active === true);
  const published = [...publication.observations].sort(byTime).some((o) => o.claim === "camera");
  const sendFailed = statsFailed.kind === "present" && statsFailed.observations.length > 0;

  // Upstream state for the finding: what the publisher-side witnesses say.
  const hop = !published || encoded.length === 0 ? "publisher_uplink" : sendFailed ? "publisher_uplink" : "client_encode";
  const module = hop === "client_encode" ? "sdk.media" : "network";

  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: cameraIngress[0]?.window.from_ms ?? at, to_ms: ingressFlow.last?.window.to_ms ?? at },
    hop,
    module,
    reason: null,
    upstream: liveBound ? "witnessed" : "unknown",
    observed: !published
      ? "the camera is live+bound but the SFU never registered the publication"
      : `the SFU sees the publication but ingress packets never flowed (${cameraIngress.length} rows)`,
    facts: [
      ...(published ? publication.observations.filter((o) => o.claim === "camera").slice(-1).map((o) => ({ text: "sfu.publication.started(camera)", evidence: [o.id], window: o.window, absent: null })) : [{ text: "no sfu.publication.started for the camera", evidence: [], window: { from_ms: at, to_ms: at }, absent: "video.publication" }]),
      ...cameraIngress.slice(-2).map((o) => ({ text: `ingress packets=${o.value.packets}`, evidence: [o.id], window: o.window, absent: null })),
      ...encoded.slice(-1).map((o) => ({ text: `send layer ${o.value.rid ?? ""} frames_encoded=${o.value.frames_encoded} active=${o.value.active}`, evidence: [o.id], window: o.window, absent: null })),
      ...(sendFailed ? [{ text: `video.stats_failed ${statsFailed.observations[0].claim}`, evidence: [statsFailed.observations[0].id], window: statsFailed.observations[0].window, absent: null }] : []),
    ],
    hypothesis: { text: hop === "client_encode" ? "the camera track bound but the encoder produced nothing" : "packets left the publisher but never reached the SFU", falsified_by: "an ingress row with packets growing ≥50 inside 35 s" },
    falsify: { absence: null, attribution: "ingress growth, a flowing send layer, or a publication.started row" },
  };
}

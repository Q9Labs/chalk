// @ts-check
/**
 * video.camera_stopped: the publisher's camera left `live` with a bound publication and stayed ended without a cause.
 *
 * The witnesses are in areas/video.json: `video.camera_state` is required; `video.camera_track_muted`,
 * `video.camera_capture`, `video.capture_intent`, `video.connection` corroborate. The machine's `trigger` names the
 * cause the caller gave: released/unbound/cleared/cancelled with the intent off are the participant's choice;
 * track_ended, device_switched and captured's capture_not_live ending need the person not to have asked.
 *
 * BROKEN, hop=client_capture, when a live+bound camera ends with a trigger the person did not cause, or ends with no
 * trigger a named terminal explains. EXPECTED with video.call_ended near an Episode end, and video.reconnecting when a
 * reconnect stretch the picture matched within 10 s explains it.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "video.camera_stopped";

/** How close to an Episode end a stop sits and still reads expected. */
const CALL_ENDED_MS = 10_000;
/** How long after a reconnected transition the camera may take to come back and still be expected. */
const RECONNECT_GRACE_MS = 10_000;
/** Triggers that mean the participant or the lifecycle released the camera on purpose. */
const DELIBERATE = new Set(["released", "unbound", "cleared", "cancelled", "device_switched"]);

export const expected = "a live+bound camera stays live until a released/unbound/cleared/cancelled trigger the intent asked for, or the Episode's end";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

const byTime = (a, b) => a.window.from_ms - b.window.from_ms;

function connectionAt(connection, atMs) {
  const rows = [...connection.observations].sort(byTime).filter((o) => o.window.from_ms <= atMs);
  return rows.length ? rows[rows.length - 1] : null;
}

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const camera = readings["video.camera_state"];
  const intent = readings["video.capture_intent"];
  const connection = readings["video.connection"] ?? { kind: "absent", observations: [] };
  const episodeEnded = readings["video.episode_ended"];

  if (camera.kind !== "present") return { status: "unknown", reason: "the camera machine is not witnessed for this seat" };

  // video.camera_state carries machine transitions (claim: to_state) and bound-bit flips (claim: camera_bound).
  const transitions = camera.observations.filter((o) => o.claim !== "true" && o.claim !== "false").sort(byTime);
  const bounds = camera.observations.filter((o) => o.claim === "true" || o.claim === "false").sort(byTime);
  const boundAt = (ms) => {
    const b = bounds.filter((o) => o.window.from_ms <= ms).at(-1);
    return b !== undefined && b.claim === "true";
  };
  const last = transitions[transitions.length - 1];
  /** Was the camera live with the bound bit true in the stretch that ended at `ms`? */
  const liveBoundAt = (i) => transitions[i].claim === "live" && boundAt(i + 1 < transitions.length ? transitions[i + 1].window.from_ms : last.window.to_ms);
  const everLive = transitions.some((o, i) => liveBoundAt(i));
  if (!everLive) return { status: "pass" };

  // The stop: the first transition that leaves a live+bound stretch, and stays out of live+bound.
  let stop = null;
  for (const [i, o] of transitions.entries()) {
    if (i === 0 || transitions[i - 1].claim !== "live" || !boundAt(o.window.from_ms)) continue;
    const back = transitions.slice(i + 1).some((n, j) => liveBoundAt(i + 1 + j));
    if (!back) { stop = o; break; }
  }
  if (!stop) return { status: "pass" };

  const at = stop.window.from_ms;
  const conn = connection.kind === "present" ? connectionAt(connection, at) : null;
  if (conn && ["reconnecting", "leaving", "left", "failed"].includes(conn.claim)) return { status: "unknown", reason: `the seat is ${conn.claim}` };

  // Reconnect clause: a reconnect began before the stop, was not caused by receive_stalled, and the picture returned
  // within 10 s of the matching reconnected transition.
  if (connection.kind === "present") {
    const rows = [...connection.observations].sort(byTime);
    const rec = rows.find((o) => o.claim === "reconnecting" && o.window.from_ms <= at && o.value.trigger !== "receive_stalled");
    if (rec) {
      const recovered = rows.find((o) => o.claim === "live" && o.window.from_ms >= rec.window.from_ms);
      const back = transitions.find((o, i) => liveBoundAt(i) && o.window.from_ms >= rec.window.from_ms);
      if (recovered && back && back.window.from_ms - recovered.window.from_ms <= RECONNECT_GRACE_MS) return { status: "pass" };
    }
  }

  const ended = episodeEnded.kind === "present" && episodeEnded.observations.some((o) => Math.abs(o.window.from_ms - at) <= CALL_ENDED_MS);
  const intentOff = intent.kind === "present" && intent.observations.some((o) => o.claim === "false" && o.value.source === "camera" && o.window.from_ms <= at);
  const intentOn = intent.kind === "present" && intent.observations.some((o) => o.claim === "true" && o.value.source === "camera" && o.window.from_ms <= at);
  const trigger = String(stop.value.trigger ?? "");
  // A deliberate trigger names the product path that ended the camera; it is a fault only when the
  // participant's intent said the camera should still be on.
  const deliberate = DELIBERATE.has(trigger);

  if (ended) {
    return {
      status: "finding",
      outcome: "expected",
      window: stop.window,
      hop: "client_capture",
      module: "sdk.media",
      reason: "video.call_ended",
      upstream: "witnessed",
      observed: `the camera ended (trigger ${trigger}) with the Episode's end`,
      facts: [
        { text: `video.camera ${stop.value.from_state} -> ${stop.claim} (trigger ${trigger})`, evidence: [stop.id], window: stop.window, absent: null },
        { text: "the Episode's end is within 10 s", evidence: episodeEnded.observations.map((o) => o.id), window: stop.window, absent: null },
      ],
      hypothesis: { text: "the camera was let go because the Episode ended", falsified_by: "the Episode continuing past the stop" },
      falsify: { absence: null, attribution: "the Episode continuing while the camera stayed down" },
    };
  }
  if (deliberate && !intentOn) return { status: "pass" };

  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: at, to_ms: stop.window.to_ms },
    hop: "client_capture",
    module: "sdk.media",
    reason: null,
    upstream: null,
    observed: `a live+bound camera ended (trigger ${trigger || "none"}) and stayed down`,
    facts: [
      { text: `video.camera ${stop.value.from_state} -> ${stop.claim} (trigger ${trigger || "none"})`, evidence: [stop.id], window: stop.window, absent: null },
      ...(intentOff ? [{ text: "the participant's camera intent was off", evidence: intent.observations.filter((o) => o.claim === "false").map((o) => o.id), window: stop.window, absent: null }] : []),
    ],
    hypothesis: null,
    falsify: { absence: null, attribution: "a trigger the participant caused, or a live+bound transition after the stop" },
  };
}

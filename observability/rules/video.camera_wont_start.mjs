// @ts-check
/**
 * video.camera_wont_start: the publisher's camera never reached `live` with a bound publication.
 *
 * The witnesses are in areas/video.json: `video.camera_capture` (the capture op's terminal) and `video.camera_state`
 * (the video.camera machine's transitions) are required; `video.device_failure`, `video.camera_effects`,
 * `video.capture_intent`, `video.camera_track_muted` and `video.connection` corroborate.
 *
 * BROKEN, hop=client_capture, when a capture op ended error(video.*), or the machine entered `capturing` and reached
 * `ended` without ever reaching `live` with bound=true. EXPECTED with reason video.permission_denied when the op ended
 * expected(video.permission_denied), and video.call_ended when an Episode end or leave is near. A seat that is not
 * connected is not checked.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "video.camera_wont_start";

/** How close to an Episode end or a leave a stop can sit and still read expected. */
const CALL_ENDED_MS = 10_000;

export const expected = "a capture op ends ok and the camera machine reaches live with bound=true; a refusal is expected(video.permission_denied) only when the permission probe shows the person refused";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

const byTime = (a, b) => a.window.from_ms - b.window.from_ms;

/** The last connection transition before `atMs`, or null. */
function connectionAt(connection, atMs) {
  const rows = [...connection.observations].sort(byTime).filter((o) => o.window.from_ms <= atMs);
  return rows.length ? rows[rows.length - 1] : null;
}

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const capture = readings["video.camera_capture"];
  const camera = readings["video.camera_state"];
  const intent = readings["video.capture_intent"];
  const muted = readings["video.camera_track_muted"] ?? { kind: "absent", observations: [] };
  const effects = readings["video.camera_effects"];
  const device = readings["video.device_failure"];
  const connection = readings["video.connection"] ?? { kind: "absent", observations: [] };
  const episodeEnded = readings["video.episode_ended"];

  if (capture.kind !== "present" || camera.kind !== "present") {
    return { status: "unknown", reason: "no capture op or camera transition is witnessed for this seat" };
  }

  // video.camera_state carries machine transitions (claim: to_state) and bound-bit flips (claim:
  // camera_bound). Bound rows follow their transition's emit, so ordering is by seq, not wall time.
  const bySeq = (a, b) => (a.value.seq ?? 0) - (b.value.seq ?? 0);
  const transitions = camera.observations.filter((o) => o.claim !== "true" && o.claim !== "false").sort(bySeq);
  const bounds = camera.observations.filter((o) => o.claim === "true" || o.claim === "false").sort(bySeq);
  /** The bound bit as of just before seq `limit`. */
  const boundBefore = (limit) => {
    const b = bounds.filter((o) => (o.value.seq ?? 0) < limit).at(-1);
    return b !== undefined && b.claim === "true";
  };
  const ops = [...capture.observations].sort(byTime);
  const last = transitions[transitions.length - 1];
  const at = last.window.from_ms;

  // Never fire while the seat is disconnected: the camera machine is not expected to move then.
  const conn = connection.kind === "present" ? connectionAt(connection, at) : null;
  if (conn && (conn.claim === "reconnecting" || conn.claim === "idle" || conn.claim === "joining" || conn.claim === "leaving" || conn.claim === "left" || conn.claim === "failed")) {
    return { status: "unknown", reason: `the seat is ${conn.claim}` };
  }

  // A live stretch was bound when the bound bit read true at any point before it left live.
  const liveBound = transitions.some((o, i) => o.claim === "live" && boundBefore(i + 1 < transitions.length ? (transitions[i + 1].value.seq ?? 0) : Number.MAX_SAFE_INTEGER));
  if (liveBound) return { status: "pass" };
  if (!transitions.some((o) => o.claim === "capturing")) return { status: "unknown", reason: "the camera never entered capturing" };

  // Reachable: some capture was asked for and never reached live+bound.
  const failures = ops.filter((o) => o.failure === true);
  const refusal = ops.find((o) => o.claim === "expected" && o.value.reason_code === "video.permission_denied");
  const ended = episodeEnded.kind === "present" && episodeEnded.observations.some((o) => Math.abs(o.window.from_ms - at) <= CALL_ENDED_MS);

  const effectsRow = effects.kind === "present" ? effects.observations.find((o) => o.claim === "failed" && o.value.media_state_code === "media_capture_failed") : null;
  const deviceRow = device.kind === "present" ? device.observations.find((o) => o.claim === "camera") : null;
  const mutedRow = muted.kind === "present" ? muted.observations.find((o) => o.claim === "true") : null;
  const intentOff = intent.kind === "present" && intent.observations.some((o) => o.claim === "false" && o.value.source === "camera");

  const worst = failures[failures.length - 1] ?? null;
  const code = worst?.value.reason_code ?? (effectsRow ? "video.media_capture_failed" : null);

  if (refusal && !failures.some((o) => o !== refusal) && !ended) {
    return {
      status: "finding",
      outcome: "expected",
      window: refusal.window,
      hop: "client_capture",
      module: "sdk.media",
      reason: "video.permission_denied",
      upstream: null,
      observed: `the capture op ended expected(video.permission_denied); the person refused the prompt`,
      facts: [
        { text: `the capture op ended ${refusal.claim}(${refusal.value.reason_code})`, evidence: [refusal.id], window: refusal.window, absent: null },
        ...(refusal.value.permission_after ? [{ text: `permission_after=${refusal.value.permission_after}`, evidence: [refusal.id], window: refusal.window, absent: null }] : []),
      ],
      hypothesis: null,
      falsify: { absence: null, attribution: "a later capture reaching live, or permission probes showing a system block" },
    };
  }

  if (ended && !worst) {
    return {
      status: "finding",
      outcome: "expected",
      window: last.window,
      hop: "client_capture",
      module: "sdk.media",
      reason: "video.call_ended",
      upstream: "witnessed",
      observed: "the capture stretch ends with the Episode's end, not a fault",
      facts: [{ text: "the Episode's end is within 10 s of the last camera transition", evidence: episodeEnded.observations.map((o) => o.id), window: last.window, absent: null }],
      hypothesis: { text: "the camera was let go because the Episode ended", falsified_by: "a camera live+bound row after the Episode's end" },
      falsify: { absence: null, attribution: "the Episode continuing while the camera stayed down" },
    };
  }

  if (intentOff) return { status: "pass" };

  const window = worst?.window ?? { from_ms: transitions.find((o) => o.claim === "capturing")?.window.from_ms ?? last.window.from_ms, to_ms: last.window.to_ms };
  const module = effectsRow ? "sdk.camera_effects" : "sdk.media";
  const reasons = [
    worst ? `the capture op ended ${worst.claim}(${worst.value.reason_code ?? "unclassified"})` : null,
    deviceRow ? `a device_failed(camera) row names ${deviceRow.value.capture_error_name ?? "unknown"}` : null,
    effectsRow ? "a camera-effects path recorded media_capture_failed" : null,
    mutedRow ? "the camera track stayed muted" : null,
    !worst && !deviceRow && !effectsRow ? "the machine ended the capture without a named failure" : null,
  ].filter(Boolean);
  return {
    status: "finding",
    outcome: "broken",
    window,
    hop: "client_capture",
    module,
    reason: null,
    upstream: null,
    observed: `the camera never reached live+bound: ${reasons.join("; ")}`,
    facts: [
      ...transitions.slice(-3).map((o) => ({ text: `video.camera ${o.value.from_state} -> ${o.claim} (trigger ${o.value.trigger})`, evidence: [o.id], window: o.window, absent: null })),
      ...(worst ? [{ text: `capture op ${worst.claim}(${worst.value.reason_code ?? "unclassified"})`, evidence: [worst.id], window: worst.window, absent: null }] : []),
      ...(deviceRow ? [{ text: "device_failed(camera)", evidence: [deviceRow.id], window: deviceRow.window, absent: null }] : []),
    ],
    hypothesis: null,
    falsify: { absence: null, attribution: "a live+bound transition, or an expected() terminal the refusal probe witnessed" },
  };
}

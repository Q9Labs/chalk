// @ts-check

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "audio.not_heard";
export const expected = "microphone capture and publication succeed, and the same track reaches SFU ingress";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && declaration.features.includes("media") && seat?.can_publish === true;

const failures = new Map([
  ["capture_denied", ["mic_permission", "sdk.audio.capture", "the runtime denied a microphone-only capture request"]],
  ["input_unavailable", ["mic_device", "sdk.audio.capture", "the runtime could not open the requested microphone"]],
  ["capture_missing", ["mic_capture", "sdk.audio.capture", "capture returned without a live microphone track"]],
  ["capture_failed", ["mic_capture", "sdk.audio.capture", "the microphone-only capture request failed"]],
  ["capture_signal_no_outbound", ["client_send", "sdk.audio.send", "the microphone had input signal but outbound audio bytes did not advance"]],
  ["publish_failed", ["audio_publication", "sdk.audio.publish", "the microphone publication did not settle after the SDK's retries"]],
]);

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const client = records(readings["audio.client"]);
  const ingress = records(readings["audio.ingress"]);
  for (const row of client) {
    const failure = failures.get(row.claim);
    if (failure) {
      const finding = broken(row, failure[0], failure[1], failure[2], "a successful result for the same capture or publication attempt");
      return row.claim === "capture_signal_no_outbound" ? { ...finding, upstream: "witnessed" } : finding;
    }
  }

  for (const flat of ingress.filter((row) => row.claim === "ingress_flat")) {
    const sending = client.find((row) => row.claim === "outbound_flowing" && sameTrack(flat, row) && containsProgress(flat, row));
    if (!sending) continue;
    return withUpstream(broken(flat, "sfu_ingress", "unknown", "SFU ingress did not advance while the same publication sent RTP", "ingress progress for this microphone during the sampled interval"), sending, "outbound microphone RTP advanced in the interval");
  }

  if (readings["audio.client"].kind !== "present" || !readings["audio.client"].complete) {
    return { status: "unknown", reason: "microphone capture and publication are not fully witnessed" };
  }
  const published = client.filter((row) => row.claim === "published");
  if (published.length === 0 || !published.every((row) => client.some((capture) => capture.claim === "capture_live" && capture.origin === row.origin && capture.window.from_ms <= row.window.to_ms))) {
    return { status: "unknown", reason: "no matched live capture and microphone publication" };
  }
  if (readings["audio.ingress"].kind !== "present" || !readings["audio.ingress"].complete || !published.every((row) => ingress.some((packet) => packet.claim === "ingress_packets" && sameTrack(row, packet) && packet.window.to_ms >= row.window.from_ms))) {
    return { status: "unknown", reason: "no SFU ingress progress witnessed for every microphone publication" };
  }
  return { status: "pass" };
}

/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Reading} Reading */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").FindingDecision} FindingDecision */

/** @param {Reading} reading */
export const records = (reading) => (reading.kind === "present" ? reading.observations : []);

/** @param {Readonly<Observation>} row @param {string} hop @param {string} module @param {string} observed @param {string} falsifier */
export function broken(row, hop, module, observed, falsifier) {
  /** @type {FindingDecision} */
  const finding = {
    status: "finding",
    outcome: "broken",
    hop,
    module,
    observed,
    window: row.window,
    reason: null,
    upstream: "unknown",
    facts: [{ text: observed, evidence: [row.id], window: row.window, absent: null }],
    hypothesis: null,
    falsify: { absence: null, attribution: falsifier },
  };
  return finding;
}

/** @param {Readonly<Observation>} left @param {Readonly<Observation>} right */
export function sameTrack(left, right) {
  const track = left.value.audio_track_key;
  return typeof track === "string" && track !== "" && track === right.value.audio_track_key;
}

/** True only if the flat measurement covers every possible time of the progress measurement. @param {Readonly<Observation>} flat @param {Readonly<Observation>} progress */
export function containsProgress(flat, progress) {
  const flatMs = flat.value.audio_sample_ms;
  const progressMs = progress.value.audio_sample_ms;
  return typeof flatMs === "number" && typeof progressMs === "number" && flatMs > 0 && progressMs > 0 && flat.window.to_ms - flatMs <= progress.window.from_ms - progressMs && flat.window.from_ms >= progress.window.to_ms;
}

/** @param {FindingDecision} decision @param {Readonly<Observation>} upstream @param {string} text */
export function withUpstream(decision, upstream, text) {
  return {
    ...decision,
    upstream: /** @type {const} */ ("witnessed"),
    facts: [...decision.facts, { text, evidence: [upstream.id], window: upstream.window, absent: null }],
  };
}

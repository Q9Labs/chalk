// @ts-check
// fallow-ignore-file complexity -- the rule branches on every kind of evidence; its fixtures and the diagnose-call tests cover each branch, which the CRAP estimate cannot see.
/**
 * audio.not_heard: a seat unmuted for long enough, with no voiced audio reaching SFU ingress. A per-seat chain across two independent
 * witnesses (client microphone state, SFU ingress), with an optional upstream witness (capture level) that turns "upstream unknown"
 * into an attributed hop and a hypothesis.
 */
import { overlaps } from "../../scripts/diagnose-call/proof/evidence.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Fact} Fact */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

/** @param {Readonly<Observation>} o */
const cite = (o) => [o.id];

export const symptom = "audio.not_heard";

/** Unmuted for less than this is too short to call silent. */
const SILENT_MIN_MS = 5_000;
/** A capture level above this is a voice, not the noise floor. */
const VOICE_DBFS = -50;

/** @param {readonly Readonly<Observation>[]} list @param {string} name */
const sum = (list, name) => list.reduce((total, o) => total + Number(o.value[name] ?? 0), 0);

export const expected = `while the microphone is unmuted for ${SILENT_MIN_MS / 1000} s or more, voiced audio packets reach SFU ingress`;

/** A seat that stayed muted sends no audio, so SFU ingress with no rollup for it is the healthy claim; an unmuted seat's missing ingress is the finding. */
export const healthy_absent = ["audio.ingress"];

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && declaration.features.includes("media") && seat !== null && seat.can_publish;

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings }) {
  const mic = readings["audio.mic_state"];
  const ingress = readings["audio.ingress"];
  const capture = readings["audio.capture"];
  if (mic.kind !== "present") return { status: "unknown", reason: "microphone state not witnessed" };
  const unmuted = mic.observations.filter((o) => o.claim === "unmuted" && o.window.to_ms - o.window.from_ms >= SILENT_MIN_MS);
  if (ingress.kind === "unknown") return { status: "unknown", reason: "SFU ingress not witnessed" };
  const silent = unmuted.flatMap((u) => {
    const rollups = ingress.kind === "present" ? ingress.observations.filter((o) => overlaps(o.window, u.window)) : [];
    return rollups.length === 0 || sum(rollups, "voiced") === 0 ? [{ u, rollups }] : [];
  });
  if (silent.length === 0) return { status: "pass" };

  /** @type {Fact[]} */
  const facts = silent.flatMap(({ u, rollups }) => [
    rollups.length === 0 ? { text: "no audio packets at SFU ingress", evidence: [], window: u.window, absent: "audio.ingress" } : { text: `SFU ingress ${sum(rollups, "packets")} packets, 0 voiced`, evidence: rollups.map((o) => o.id), window: u.window, absent: null },
    { text: "microphone unmuted", evidence: cite(u), window: u.window, absent: null },
  ]);
  const window = { from_ms: silent[0].u.window.from_ms, to_ms: /** @type {{ u: Readonly<Observation> }} */ (silent.at(-1)).u.window.to_ms };
  const levels = capture.kind === "present" && capture.complete ? capture.observations.filter((o) => overlaps(o.window, window)) : [];
  const packets = sum(
    silent.flatMap(({ rollups }) => rollups),
    "packets",
  );
  const base = { status: /** @type {const} */ ("finding"), outcome: /** @type {const} */ ("broken"), window, observed: `unmuted, ${packets} packets and 0 voiced at SFU ingress` };
  const falsifyAbsence = "a voiced audio rollup at SFU ingress inside the window";
  if (levels.length === 0) {
    return { ...base, hop: "sfu_ingress", module: "unknown", reason: null, upstream: "unknown", facts, hypothesis: null, falsify: { absence: falsifyAbsence, attribution: "audio.capture (the microphone level before WebRTC) is not witnessed, so which client hop failed is unproved" } };
  }
  const loudest = Math.max(...levels.map((o) => Number(o.value.rms_max_dbfs ?? -Infinity)));
  const level = { text: `capture level peaked at ${loudest} dBFS`, evidence: levels.map((o) => o.id), window, absent: null };
  if (loudest > VOICE_DBFS) {
    return {
      ...base,
      hop: "client_send",
      module: "sdk.audio",
      reason: null,
      upstream: "witnessed",
      facts: [...facts, level],
      hypothesis: { text: "the sender dropped or replaced the captured track", falsified_by: "outbound RTP with voiced packets in the window" },
      falsify: { absence: falsifyAbsence, attribution: `a capture level at or below ${VOICE_DBFS} dBFS` },
    };
  }
  return {
    ...base,
    hop: "client_capture",
    module: "sdk.audio.capture",
    reason: null,
    upstream: "witnessed",
    facts: [...facts, level],
    hypothesis: { text: "a wrong or muted input device", falsified_by: "the active input device label matching the one the Participant spoke into" },
    falsify: { absence: falsifyAbsence, attribution: `a capture level above ${VOICE_DBFS} dBFS` },
  };
}

// @ts-check
/**
 * transcript.speech_dropped: the dispatcher measured at least 2000 ms of speech in the audio, but the stored document has
 * zero cues. Judged on the finalize job.
 *
 * Two independent witnesses: db (every chunk's accepted attempt is the openrouter/MAI provider and their measured speech sums
 * >= 2000) and r2 (the readback's cue count is 0). A chunk whose accepted attempt names another provider gives
 * unknown(no_speech_measure), because the measurement only means something for the MAI provider.
 */
import { field, obs, unknown } from "./transcript.shared.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "transcript.speech_dropped";

export const expected = "audio the -45 dB gate counted as >= 2000 ms of speech produces a stored document with at least one cue";

const SPEECH_MS = 2000;

export const settle_ms = 60_000;

/** @param {Declaration} declaration */
export const applies = (declaration, seat) => seat === null && declaration.kind === "job" && declaration.job_kind === "transcription_finalize";

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const row = readings["transcript.row"];
  if (row.kind !== "present") return unknown("the transcription row is not witnessed");
  const [transcript] = row.observations;
  if (transcript.claim === "deleted" || field(transcript, "transcript_deleted", false) === true || field(transcript, "transcript_exists", true) === false) return { status: "pass" };
  if (transcript.claim !== "complete") return { status: "pass" };

  const attempts = obs(readings["transcript.attempts"]);
  if (readings["transcript.attempts"].kind !== "present") return unknown("the chunk attempts are not witnessed");
  const chunks = new Map();
  for (const attempt of attempts) {
    const index = /** @type {number} */ (field(attempt, "transcript_chunk_index", 0));
    const list = chunks.get(index) ?? [];
    list.push(attempt);
    chunks.set(index, list);
  }
  const chunkCount = /** @type {number} */ (field(transcript, "transcript_chunk_count", chunks.size));
  if (chunks.size < chunkCount) return unknown("not every chunk's attempts are witnessed");
  let speech = 0;
  const cited = [transcript.id];
  for (const [index, list] of [...chunks].sort(([a], [b]) => a - b)) {
    const accepted = list.find((o) => o.claim === "accepted");
    if (accepted === undefined) return unknown(`chunk ${index} has no accepted attempt`);
    if (field(accepted, "transcript_provider", "") !== "openrouter") return unknown("no_speech_measure");
    speech += /** @type {number} */ (field(accepted, "transcript_observed_ms", field(accepted, "transcript_speech_ms", 0)));
    cited.push(accepted.id);
  }
  const object = readings["transcript.object"];
  if (object.kind !== "present") return unknown("the stored document's readback is not witnessed");
  const [readback] = object.observations;
  const cues = /** @type {number} */ (field(readback, "transcript_cue_count", -1));
  if (speech < SPEECH_MS || cues !== 0) return { status: "pass" };
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: Math.min(transcript.window.from_ms, readback.window.from_ms), to_ms: readback.window.to_ms },
    hop: "provider",
    module: "dispatcher.provider",
    reason: null,
    upstream: "witnessed",
    observed: `speech_ms=${speech} but the final document has 0 cues`,
    facts: [
      { text: `speech_ms=${speech} segments=0`, evidence: cited, window: { from_ms: transcript.window.from_ms, to_ms: transcript.window.to_ms }, absent: null },
      { text: "final document 0 cues", evidence: [readback.id], window: readback.window, absent: null },
    ],
    hypothesis: { text: "provider returned no words for audio the -45 dB gate counted as speech", falsified_by: "playback with no voices" },
    falsify: { absence: null, attribution: "a stored document whose cue count matches the measured speech" },
  };
}

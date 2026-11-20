// @ts-check
/**
 * transcript.unreadable: the transcription is complete but its stored document is missing, differs from the recorded
 * metadata, fails validation, or the API failed to read a document that is in fact readable.
 *
 * The r2 readback is the checker's own: it proves missing/mismatch/decode at store / storage.r2. When the readback passes but a
 * transcript.document_read op ended error, the read path is broken at serve / api.transcripts. A null artifact_sha256 leaves size
 * and validation run but returns unknown(no_checksum) when they pass.
 */
import { field, obs, unknown } from "./transcript.shared.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "transcript.unreadable";

export const expected = "a complete transcription's stored document reads back byte-for-byte and every document read succeeds";

export const settle_ms = 60_000;

/** Nothing may ever read the document; a pass over the proven absence of reads is healthy. */
export const healthy_absent = ["transcript.doc"];

/** @param {Declaration} declaration */
export const applies = (declaration, seat) => seat === null && declaration.kind === "job" && declaration.job_kind === "transcription_finalize";

const RESULT_TEXT = /** @type {const} */ ({
  not_found: "readback 404",
  error: "readback failed",
  size_mismatch: "readback size differs from artifact_size",
  sha_mismatch: "readback sha256 differs from artifact_sha256",
  type_mismatch: "readback content type is not application/json",
  invalid: "readback fails transcript.v1 validation",
});

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const row = readings["transcript.row"];
  if (row.kind !== "present") return unknown("the transcription row is not witnessed");
  const [transcript] = row.observations;
  const status = transcript.claim;
  if (status === "deleted" || field(transcript, "transcript_deleted", false) === true) return { status: "pass" };
  if (field(transcript, "transcript_exists", true) === false) return unknown("the Recording has no transcription row");
  if (status !== "complete") return { status: "pass" };

  const object = readings["transcript.object"];
  if (field(transcript, "transcript_artifact_set", true) === false) {
    return {
      status: "finding",
      outcome: "broken",
      window: { from_ms: transcript.window.from_ms, to_ms: transcript.window.to_ms },
      hop: "store",
      module: "storage.r2",
      reason: null,
      upstream: "unknown",
      observed: "transcription complete but artifact_key, artifact_size or artifact_content_type is not stored",
      facts: [{ text: "transcription complete, artifact metadata missing", evidence: [transcript.id], window: transcript.window, absent: null }],
      hypothesis: null,
      falsify: { absence: null, attribution: "the stored artifact key, size and content type" },
    };
  }
  if (object.kind !== "present") return unknown("the stored document's readback is not witnessed");
  const [readback] = object.observations;
  if (readback.claim !== "ok") {
    const text = RESULT_TEXT[/** @type {keyof RESULT_TEXT} */ (readback.claim)] ?? `readback ${readback.claim}`;
    return {
      status: "finding",
      outcome: "broken",
      window: { from_ms: readback.window.from_ms, to_ms: readback.window.to_ms },
      hop: "store",
      module: "storage.r2",
      reason: null,
      upstream: "unknown",
      observed: `${text} on a complete transcription`,
      facts: [
        { text, evidence: [readback.id], window: readback.window, absent: null },
        { text: "transcription complete", evidence: [transcript.id], window: transcript.window, absent: null },
      ],
      hypothesis: null,
      falsify: { absence: null, attribution: "a readback whose bytes match the recorded artifact metadata" },
    };
  }
  if (field(transcript, "transcript_sha_set", true) === false) return unknown("no_checksum");
  const failed = obs(readings["transcript.doc"]).filter((o) => o.claim === "error");
  if (failed.length > 0) {
    const latest = failed.reduce((a, b) => (a.window.to_ms >= b.window.to_ms ? a : b));
    return {
      status: "finding",
      outcome: "degraded",
      window: { from_ms: latest.window.from_ms, to_ms: latest.window.to_ms },
      hop: "serve",
      module: "api.transcripts",
      reason: null,
      upstream: "witnessed",
      observed: `the document reads back fine but transcript.document_read ended ${field(latest, "reason_code", "error")}`,
      facts: [
        { text: `document_read ${field(latest, "transcript_route", "document")} failed (${field(latest, "reason_code", "unclassified")})`, evidence: [latest.id], window: latest.window, absent: null },
        { text: "readback ok", evidence: [readback.id], window: readback.window, absent: null },
      ],
      hypothesis: null,
      falsify: { absence: null, attribution: "a document_read op that ends ok on a readable object" },
    };
  }
  return { status: "pass" };
}

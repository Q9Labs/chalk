// @ts-check
/**
 * Shared helpers for the slice-11 transcript rules. The db source is the authority; api and lambda rows only pick the
 * module or serve the serve-side witnesses, per docs/plans/hyper-observability/slices/11-transcription.md.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Reading} Reading */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

/** @param {Reading | undefined} reading @returns {readonly Readonly<Observation>[]} */
export const obs = (reading) => (reading?.kind === "present" ? reading.observations : []);

/** @param {Readonly<Observation>} o @param {string} key @param {unknown} fallback */
export const field = (o, key, fallback) => {
  const value = o.value?.[key];
  return value === undefined || value === null ? fallback : value;
};

/** The asof a db witness proves: its read time, stamped as est_server_ms. */
/** @param {readonly Readonly<Observation>[]} rows */
export const asof = (rows) => rows.reduce((latest, o) => Math.max(latest, o.window.to_ms), 0);

/** The hop and module the spec's error code map gives a failed job. */
/** @param {string} code @param {string} jobKind @returns {{ hop: string, module: string }} */
export function errorAttribution(code, jobKind) {
  let module = "dispatcher.queue";
  if (["provider_timeout", "provider_schema_invalid", "provider_rate_limited", "provider_unavailable", "provider_rejected"].includes(code)) module = "dispatcher.provider";
  else if (["lease_expired", "timeout", "dispatcher_failure", "network_failure"].includes(code)) module = "dispatcher.runtime";
  else if (code === "control_api_rejected") module = "api.transcription_worker";
  else if (["assignment_invalid", "chunk_download_retryable"].includes(code)) module = "dispatcher.assignment";
  return { hop: jobKind === "transcription_finalize" ? "finalize" : module === "dispatcher.provider" ? "provider" : module === "api.transcription_worker" ? "accept" : "chunk", module };
}

/** Window covering the observations, or a point window at `at` when there are none. */
/** @param {readonly Readonly<Observation>[]} observations @param {number} at */
export const covering = (observations, at) => ({
  from_ms: observations.reduce((earliest, o) => Math.min(earliest, o.window.from_ms), at),
  to_ms: observations.reduce((latest, o) => Math.max(latest, o.window.to_ms), at),
});

export const PASS = /** @type {const} */ ({ status: "pass" });
/** @param {string} reason @returns {Decision} */
export const unknown = (reason) => ({ status: "unknown", reason });

/** `transcription.*` job kinds slice 11 judges on artifact_jobs rows. */
export const TRANSCRIPTION_JOB_KINDS = new Set(["transcription_chunk", "transcription_finalize"]);
/** Claim-handler failure decisions: the lease committed and the handler then failed (issue #1510). */
export const CLAIM_HANDLER_FAILURES = new Set(["url_failed", "invalid_assignment", "lease_stale"]);

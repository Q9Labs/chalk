// @ts-check
/**
 * Shared helpers for the slice-10 recording rules: reading accessors, window math and the job predicates
 * the checks share. A finding names the hop that failed and the module that owns it; `unknown` names what
 * could not be read, and never stands in for healthy.
 */

/** @param {any} reading */
export const obs = (reading) => (reading?.kind === "present" ? reading.observations : []);

/** @param {any} o @param {string} key @param {any} fallback */
export const field = (o, key, fallback) => (o?.value?.[key] === undefined || o.value[key] === null ? fallback : o.value[key]);

/** @param {string} reason */
export const unknown = (reason) => ({ status: "unknown", reason });

export const PASS = /** @type {const} */ ({ status: "pass" });

/** The as-of of a rule's item world: the latest window edge its rows reached. @param {any[]} rows */
export const asof = (rows) => rows.reduce((latest, o) => Math.max(latest, o.window.to_ms), 0);

/** @param {any[]} observations @param {number} at */
export const covering = (observations, at) => ({
  from_ms: observations.reduce((earliest, o) => Math.min(earliest, o.window.from_ms), at),
  to_ms: at,
});

/** The item's one job row, when present. @param {any} readings */
export const jobRow = (readings) => obs(readings["recording.job_state"])[0];
/** @param {any} readings */
export const pipelineRow = (readings) => obs(readings["recording.pipeline"])[0];
/** @param {any} readings */
export const recordingRow = (readings) => obs(readings["recording.row"])[0];

/** Terminal job states that mean the work is over. */
export const TERMINAL = new Set(["succeeded", "terminal_failure", "cancelled"]);

/** Capture hop error codes that are not a capture_failed finding. */
export const EMPTY_CODE = "capture_empty";

/**
 * One item fact: the text, the evidence ids behind it and its window.
 * @param {string} text @param {any[]} evidence @param {string | null} absent
 */
export const fact = (text, evidence, absent = null) => ({
  text,
  evidence: evidence.map((o) => o.id),
  window: covering(evidence, asof(evidence)),
  absent,
});

/**
 * A broken finding for the item.
 * @param {{ hop: string, module: string, reason?: string | null, observed: string, facts: any[], at: number, evidence?: any[] }} f
 */
export const broken = ({ hop, module, reason = null, observed, facts, at, evidence = [] }) => ({
  status: "finding",
  outcome: "broken",
  window: evidence.length ? covering(evidence, at) : { from_ms: at, to_ms: at },
  hop,
  module,
  reason,
  upstream: "unknown",
  observed,
  facts,
  hypothesis: null,
  falsify: { absence: null, attribution: "evidence the job completed without this fault" },
});

/**
 * An expected finding for the item.
 * @param {{ hop: string, module: string, reason: string, observed: string, facts: any[], at: number, evidence?: any[] }} f
 */
export const expectedFinding = ({ hop, module, reason, observed, facts, at, evidence = [] }) => ({
  status: "finding",
  outcome: "expected",
  window: { from_ms: at, to_ms: at },
  hop,
  module,
  reason,
  upstream: "unknown",
  observed,
  facts,
  hypothesis: null,
  falsify: { absence: null, attribution: "evidence the expected cause did not happen" },
});

/** Job item predicates shared by the capture checks. @param {any} declaration @param {any} seat */
export const captureJob = (declaration, seat) => seat === null && declaration.kind === "job" && declaration.job_kind === "capture";
/** @param {any} declaration @param {any} seat */
export const renderJob = (declaration, seat) => seat === null && declaration.kind === "job" && declaration.job_kind === "render";

/** Sent media on the capture session, summed over the item's transport rows. @param {any} readings */
export const captureSent = (readings) =>
  obs(readings["recording.capture_transport"])
    .filter((o) => field(o, "session_kind", "participant") === "capture")
    .reduce((sum, o) => Math.max(sum, field(o, "recording_sent_audio", 0) + field(o, "recording_sent_video", 0)), 0);

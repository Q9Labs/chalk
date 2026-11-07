// @ts-check
// The Chalk performance scorecard, draft v1: one file per media plane per run. History is public, so a file
// holds no host, IP, URL, Tenant, Space or other resource id.

export const SCORECARD_SCHEMA = "chalk.scorecard/v1";

/** @typedef {"chalk_sfu" | "cf_sfu"} MediaPlane */
/** @typedef {"pr" | "nightly" | "promote" | "manual"} Tier */
/** @typedef {"ci" | "staging" | "production"} Environment */
/**
 * @typedef {object} ScorecardClient
 * @property {"browser" | "sdk"} kind
 * @property {string} browser  Engine and version, for example "chromium/151.0.7922.34".
 * @property {string} region   Where the client ran, for example "do-sgp1".
 * @property {string} size     The client machine, for example "s-4vcpu-8gb".
 */
/**
 * @typedef {object} ScorecardRun
 * @property {string} id
 * @property {string} commit  The full SHA the run measured.
 * @property {Tier} tier
 * @property {Environment} environment
 * @property {string} startedAt  ISO 8601.
 * @property {ScorecardClient} client
 */
/**
 * @typedef {object} ScorecardMetric
 * @property {MetricId} id
 * @property {Unit} unit  Must match the unit METRICS gives the id.
 * @property {number} n  Samples behind the percentiles; dropped samples are not counted.
 * @property {number | null} p50  Null only when n is 0.
 * @property {number | null} p95
 * @property {string} source  The kit that measured it.
 */
/**
 * @typedef {object} ScorecardDrop
 * @property {MetricId} metric
 * @property {string} reason  A snake_case code, never free text.
 * @property {number} count
 */
/**
 * @typedef {object} Scorecard
 * @property {typeof SCORECARD_SCHEMA} schema
 * @property {ScorecardRun} run
 * @property {MediaPlane} mediaPlane
 * @property {ScorecardMetric[]} metrics
 * @property {ScorecardDrop[]} dropped
 */

// Units a metric may use. A metric's unit is fixed by its entry in METRICS.
export const UNITS = /** @type {const} */ (["ms", "kib", "percent", "pps", "mbit_s", "count", "pass"]);
/** @typedef {(typeof UNITS)[number]} Unit */

// Stable metric ids, each with its unit. Renaming an id or changing its unit breaks history, so add a new id instead.
export const METRICS = /** @type {const} */ ({
  "action.spinup_ms": { unit: "ms", description: "Episode create, first admit, and the first join() until live with a connected peer connection" },
  "action.join.first_audio_ms": { unit: "ms", description: "join() until the first audio packet from a remote" },
  "action.join.first_video_ms": { unit: "ms", description: "join() until the first decoded video frame from a remote" },
  "action.camera_toggle.on_ms": { unit: "ms", description: "Camera on until the remote's roster shows it active" },
  "action.camera_toggle.off_ms": { unit: "ms", description: "Camera off until the remote's roster shows it inactive" },
  "action.mic_toggle.on_ms": { unit: "ms", description: "Microphone on until the remote's roster shows it active" },
  "action.mic_toggle.off_ms": { unit: "ms", description: "Microphone off until the remote's roster shows it inactive" },
  "action.publish.first_frame_ms": { unit: "ms", description: "Camera on until the remote decodes the first new frame" },
  "action.publish.first_audio_ms": { unit: "ms", description: "Microphone on until the remote receives the first new audio packet" },
  "action.unpublish.removed_ms": { unit: "ms", description: "Camera off until the remote no longer holds a live camera track" },
  "action.unpublish.audio_removed_ms": { unit: "ms", description: "Microphone off until the remote no longer holds a live microphone track" },
  "action.screenshare.start_ms": { unit: "ms", description: "Screen share start until the remote decodes the first share frame" },
  "action.screenshare.stop_ms": { unit: "ms", description: "Screen share stop until the remote no longer holds a live share track" },
  "action.screenshare.start_signal_ms": { unit: "ms", description: "Screen share start until the remote's roster shows it active" },
  "action.screenshare.stop_signal_ms": { unit: "ms", description: "Screen share stop until the remote's roster shows it inactive" },
  "action.leave_ms": { unit: "ms", description: "leave() until the remote's roster drops the Participant" },
  "action.leave_ack_ms": { unit: "ms", description: "leave() until Sync acknowledges it" },
  "action.leave_media_removed_ms": { unit: "ms", description: "leave() until the remote holds no live track from the Participant" },
});
/** @typedef {keyof typeof METRICS} MetricId */

const tiers = ["pr", "nightly", "promote", "manual"];
const environments = ["ci", "staging", "production"];
const planes = ["chalk_sfu", "cf_sfu"];
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const clientKinds = ["browser", "sdk"];
// Free-form fields allow only these shapes. None holds a dot outside a browser version, so no host name fits, whatever its top-level domain.
const label = /^[a-z0-9][a-z0-9_-]*$/;
const clientLabels = { browser: /^[a-z][a-z0-9_-]*(?:\/\d+(?:\.\d+){0,3})?$/, region: label, size: label };
const forbidden = [
  ["an IP address", /\b\d{1,3}(?:\.\d{1,3}){3}\b|\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b|[0-9a-f]*::[0-9a-f]/i],
  ["a URL", /:\/\//],
  ["a resource id", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["a host name", /\b[a-z0-9-]+\.(?:com|net|org|io|dev|app|ai|cloud|internal|local)\b/i],
];

/**
 * scorecardProblems lists every way a value breaks the v1 shape or leaks an identifier; empty means valid.
 * @param {unknown} value
 * @returns {string[]}
 */
export function scorecardProblems(value) {
  const problems = [];
  const fail = (/** @type {string} */ problem) => problems.push(problem);
  const card = /** @type {any} */ (value); // Shape is unknown until checked here, field by field.
  if (card?.schema !== SCORECARD_SCHEMA) fail(`schema must be ${SCORECARD_SCHEMA}`);
  const run = card?.run;
  exactKeys(card, ["schema", "run", "mediaPlane", "metrics", "dropped"], "scorecard", fail);
  exactKeys(run, ["id", "commit", "tier", "environment", "startedAt", "client"], "run", fail);
  exactKeys(run?.client, ["kind", "browser", "region", "size"], "run.client", fail);
  if (typeof run?.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(run.id)) fail("run.id must be a plain run label");
  if (typeof run?.commit !== "string" || !/^[0-9a-f]{40}$/.test(run.commit)) fail("run.commit must be a full SHA");
  if (!tiers.includes(run?.tier)) fail(`run.tier must be one of ${tiers.join(", ")}`);
  if (!environments.includes(run?.environment)) fail(`run.environment must be one of ${environments.join(", ")}`);
  if (typeof run?.startedAt !== "string" || !isoTime.test(run.startedAt) || Number.isNaN(Date.parse(run.startedAt))) fail("run.startedAt must be a UTC ISO time");
  if (!clientKinds.includes(run?.client?.kind)) fail(`run.client.kind must be one of ${clientKinds.join(", ")}`);
  for (const [field, shape] of Object.entries(clientLabels)) if (typeof run?.client?.[field] !== "string" || !shape.test(run.client[field])) fail(`run.client.${field} must be a lowercase label`);
  if (!planes.includes(card?.mediaPlane)) fail(`mediaPlane must be one of ${planes.join(", ")}`);
  metricProblems(card?.metrics, fail);
  dropProblems(card?.dropped, fail);
  leakProblems(card, fail);
  return problems;
}

/**
 * exactKeys fails on any field outside the shape, because a spare field is a place for an identifier to hide.
 * @param {any} object
 * @param {string[]} keys
 * @param {string} where
 * @param {(problem: string) => void} fail
 */
function exactKeys(object, keys, where, fail) {
  if (!object || typeof object !== "object") return;
  for (const key of Object.keys(object)) if (!keys.includes(key)) fail(`${where}: unknown field ${key}`);
}

/**
 * @param {any} metrics
 * @param {(problem: string) => void} fail
 */
function metricProblems(metrics, fail) {
  if (!Array.isArray(metrics)) return fail("metrics must be an array");
  const seen = new Set();
  for (const metric of metrics) {
    const name = metric?.id;
    exactKeys(metric, ["id", "unit", "n", "p50", "p95", "source"], `metrics ${name}`, fail);
    if (!Object.hasOwn(METRICS, name)) fail(`metrics: unknown id ${name}`);
    if (seen.has(name)) fail(`metrics: ${name} appears twice`);
    seen.add(name);
    const expected = METRICS[/** @type {MetricId} */ (name)]?.unit;
    if (expected && metric?.unit !== expected) fail(`${name}: unit must be ${expected}`);
    if (!Number.isInteger(metric?.n) || metric.n < 0) fail(`${name}: n must be a whole number`);
    if (typeof metric?.source !== "string" || !label.test(metric.source)) fail(`${name}: source must be a lowercase label`);
    const percentiles = [metric?.p50, metric?.p95];
    if (metric?.n === 0 && percentiles.some((value) => value !== null)) fail(`${name}: p50 and p95 must be null without samples`);
    if (metric?.n > 0 && !percentiles.every((value) => Number.isFinite(value) && value >= 0)) fail(`${name}: p50 and p95 must be non-negative numbers`);
    if (metric?.n > 0 && metric.p50 > metric.p95) fail(`${name}: p50 is above p95`);
  }
}

/**
 * @param {any} dropped
 * @param {(problem: string) => void} fail
 */
function dropProblems(dropped, fail) {
  if (!Array.isArray(dropped)) return fail("dropped must be an array");
  for (const drop of dropped) {
    exactKeys(drop, ["metric", "reason", "count"], `dropped ${drop?.metric}`, fail);
    if (!Object.hasOwn(METRICS, drop?.metric)) fail(`dropped: unknown metric ${drop?.metric}`);
    if (typeof drop?.reason !== "string" || !/^[a-z][a-z_]*$/.test(drop.reason)) fail(`dropped: ${drop?.metric} reason must be a snake_case code`);
    if (!Number.isInteger(drop?.count) || drop.count < 1) fail(`dropped: ${drop?.metric} count must be a positive whole number`);
  }
}

/**
 * @param {any} card
 * @param {(problem: string) => void} fail
 */
function leakProblems(card, fail) {
  const visit = (/** @type {unknown} */ node, /** @type {string} */ path) => {
    if (typeof node === "string") {
      for (const [kind, pattern] of forbidden) if (pattern.test(node)) fail(`${path} looks like ${kind}`);
    } else if (Array.isArray(node)) node.forEach((item, index) => visit(item, `${path}[${index}]`));
    else if (node && typeof node === "object") for (const [key, item] of Object.entries(node)) visit(item, path ? `${path}.${key}` : key);
  };
  const { id: _runId, ...run } = card?.run ?? {}; // The run id is checked as a plain label above.
  visit({ ...card, run }, "");
}

/**
 * @param {unknown} value
 * @returns {Scorecard}
 */
export function parseScorecard(value) {
  const problems = scorecardProblems(value);
  if (problems.length) throw new Error(`Invalid scorecard:\n- ${problems.join("\n- ")}`);
  return /** @type {Scorecard} */ (value); // Every field was checked by scorecardProblems.
}

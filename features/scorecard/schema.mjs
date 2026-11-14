// @ts-check
// The Chalk performance scorecard, draft v1: one file per media plane per run. History is public, so a file
// holds no host, IP, URL, Tenant, Space or other resource id.

import { FAMILY_METRICS } from "./metrics.mjs";

export const SCORECARD_SCHEMA = "chalk.scorecard/v1";

/** @typedef {"chalk_sfu" | "cf_sfu"} MediaPlane */
/** @typedef {"pr" | "nightly" | "promote" | "manual"} Tier */
/** @typedef {"ci" | "nightly" | "production"} Environment */
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
 * @property {MetricId | "*"} metric  "*" for a whole-cycle drop.
 * @property {string} reason  A snake_case code, never free text.
 * @property {number} count
 */
/**
 * @typedef {object} Scorecard
 * @property {typeof SCORECARD_SCHEMA} schema
 * @property {ScorecardRun} run
 * @property {MediaPlane} mediaPlane
 * @property {ScorecardMetric[]} metrics
 * @property {ScorecardSeriesCycle[]} [series] Per-cycle action latency, with at most 60 cycles and no resource identifiers.
 * @property {ScorecardDrop[]} dropped
 * @property {object} [contention] Isolation evidence with per-signal provenance; no resource identifiers.
 */
/**
 * @typedef {object} ScorecardSeriesCycle
 * @property {number} cycle  One-based cycle index, with no other run or resource identifiers.
 * @property {string} timestamp  UTC ISO 8601 cycle start time.
 * @property {Record<string, number | null>} actions  The fixed action metric ids and their milliseconds for this cycle.
 */

// Units a metric may use. A metric's unit is fixed by its entry in METRICS. A pass value is a share from 0 to 1 and
// higher is better; every other unit is lower-is-better.
const UNITS = /** @type {const} */ (["ms", "kib", "mib", "percent", "pps", "mbit_s", "count", "score", "pass"]);
/** @typedef {(typeof UNITS)[number]} Unit */

// Stable metric ids, each with its unit. Renaming an id or changing its unit breaks history, so add a new id instead.
const ACTION_METRICS = /** @type {const} */ ({
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
  "action.unpublish.audio_removed_ms": { unit: "ms", description: "Microphone off until the remote microphone track is ended, or disabled and receiving no audio packets" },
  "action.screenshare.start_ms": { unit: "ms", description: "Screen share start until the remote decodes the first share frame" },
  "action.screenshare.stop_ms": { unit: "ms", description: "Screen share stop until the remote no longer holds a live share track" },
  "action.screenshare.start_signal_ms": { unit: "ms", description: "Screen share start until the remote's roster shows it active" },
  "action.screenshare.stop_signal_ms": { unit: "ms", description: "Screen share stop until the remote's roster shows it inactive" },
  "action.leave_ms": { unit: "ms", description: "leave() until the remote's roster drops the Participant" },
  "action.leave_ack_ms": { unit: "ms", description: "leave() until Sync acknowledges it" },
  "action.leave_media_removed_ms": { unit: "ms", description: "leave() until the remote holds no live track from the Participant" },
});

/** @type {Readonly<Record<string, {unit: Unit, description: string}>>} */
export const METRICS = { ...ACTION_METRICS, .../** @type {Record<string, {unit: Unit, description: string}>} */ (FAMILY_METRICS) };
/** @typedef {string} MetricId */

// A dropped entry with this metric covers a whole cycle (for example cycle_failed), not one metric.
export const WHOLE_CYCLE = "*";
const tiers = ["pr", "nightly", "promote", "manual"];
const environments = ["ci", "nightly", "production"];
/** Cards and workflows from before the rename call Nightly "staging". @param {string | undefined} value */
export const normalizeEnvironment = (value) => (value === "staging" ? "nightly" : value);
export const MEDIA_PLANES = ["chalk_sfu", "cf_sfu"];
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
function scorecardProblems(value) {
  const problems = [];
  const fail = (/** @type {string} */ problem) => problems.push(problem);
  const card = /** @type {any} */ (value); // Shape is unknown until checked here, field by field.
  if (card?.schema !== SCORECARD_SCHEMA) fail(`schema must be ${SCORECARD_SCHEMA}`);
  exactKeys(card, ["schema", "run", "mediaPlane", "metrics", "series", "dropped", "contention"], "scorecard", fail);
  runProblems(card?.run, fail);
  if (!MEDIA_PLANES.includes(card?.mediaPlane)) fail(`mediaPlane must be one of ${MEDIA_PLANES.join(", ")}`);
  metricProblems(card?.metrics, fail);
  if (card?.series !== undefined) seriesProblems(card.series, fail);
  dropProblems(card?.dropped, fail);
  if (card?.contention !== undefined) contentionProblems(card.contention, fail);
  leakProblems(card, fail);
  return problems;
}

/**
 * @param {any} series
 * @param {(problem: string) => void} fail
 */
function seriesProblems(series, fail) {
  if (!Array.isArray(series)) return fail("series must be an array");
  if (series.length > 60) return fail("series must contain at most 60 cycles");
  const actionIds = Object.keys(ACTION_METRICS);
  series.forEach((entry, index) => {
    exactKeys(entry, ["cycle", "timestamp", "actions"], `series[${index}]`, fail);
    if (!Number.isInteger(entry?.cycle) || entry.cycle !== index + 1) fail(`series[${index}].cycle must be ${index + 1}`);
    if (typeof entry?.timestamp !== "string" || !isoTime.test(entry.timestamp) || Number.isNaN(Date.parse(entry.timestamp))) fail(`series[${index}].timestamp must be a UTC ISO time`);
    exactKeys(entry?.actions, actionIds, `series[${index}].actions`, fail);
    if (!entry?.actions || typeof entry.actions !== "object" || Array.isArray(entry.actions)) {
      fail(`series[${index}].actions must be an object`);
      return;
    }
    for (const id of actionIds) {
      if (!Object.hasOwn(entry.actions, id)) {
        fail(`series[${index}].actions must include ${id}`);
        continue;
      }
      const value = entry.actions[id];
      if (value !== null && (!Number.isFinite(value) || value < 0)) fail(`series[${index}].actions.${id} must be non-negative milliseconds or null`);
    }
  });
}

function contentionProblems(value, fail) {
  const counts = ["foreign_episodes_seen", "foreign_sessions_seen", "events_before", "events_after", "window_events", "own_episode_events", "incarnation_changes"];
  const booleans = ["lease_acquired", "lease_lost", "zero_chalk_sfu_events", "drain"];
  const dates = ["lease_acquired_at_before", "lease_expires_at_before"];
  const fields = [...counts, ...booleans, ...dates, "lease_holder_before", "steal_max"];
  exactKeys(value, ["contended", "unobservable", "source", ...fields], "contention", fail);
  if (typeof value?.contended !== "boolean" || value?.source !== "axiom_api_logs_and_metrics_and_github_lease") fail("contention: invalid status or source");
  if (value?.unobservable !== undefined && typeof value.unobservable !== "boolean") fail("contention: unobservable must be a boolean");
  if (value?.source === "axiom_api_logs_and_metrics_and_github_lease" && value?.steal_max?.value === "unavailable" && !value?.contended && !value?.unobservable) fail("contention: unavailable node steal requires a contended card unless marked unobservable");
  for (const field of fields) {
    const item = value?.[field];
    exactKeys(item, ["value", "source"], `contention.${field}`, fail);
    if (!["github_lease", "axiom_api_logs", "node_readout", "axiom_metrics", "unavailable"].includes(item?.source)) fail(`contention.${field}: invalid source`);
    if (item?.value === "unavailable") continue;
    if (item?.source === "unavailable") fail(`contention.${field}: measured value needs a source`);
    const measured = item?.value;
    if (counts.includes(field) && (!Number.isSafeInteger(measured) || measured < 0)) fail(`contention.${field}: expected a count or unavailable`);
    if (booleans.includes(field) && typeof measured !== "boolean") fail(`contention.${field}: expected a boolean or unavailable`);
    if (dates.includes(field) && (typeof measured !== "string" || !isoTime.test(measured) || Number.isNaN(Date.parse(measured)))) fail(`contention.${field}: expected a UTC time or unavailable`);
    if (field === "lease_holder_before" && (typeof measured !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(measured))) fail("contention: lease holder must be a plain label");
    if (field === "steal_max" && (!Number.isFinite(measured) || measured < 0 || measured > 100)) fail("contention: steal must be a percent or unavailable");
  }
}

/**
 * @param {any} run
 * @param {(problem: string) => void} fail
 */
function runProblems(run, fail) {
  exactKeys(run, ["id", "commit", "tier", "environment", "startedAt", "client"], "run", fail);
  if (typeof run?.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(run.id)) fail("run.id must be a plain run label");
  if (typeof run?.commit !== "string" || !/^[0-9a-f]{40}$/.test(run.commit)) fail("run.commit must be a full SHA");
  if (!tiers.includes(run?.tier)) fail(`run.tier must be one of ${tiers.join(", ")}`);
  if (!environments.includes(run?.environment)) fail(`run.environment must be one of ${environments.join(", ")}`);
  if (typeof run?.startedAt !== "string" || !isoTime.test(run.startedAt) || Number.isNaN(Date.parse(run.startedAt))) fail("run.startedAt must be a UTC ISO time");
  exactKeys(run?.client, ["kind", "browser", "region", "size"], "run.client", fail);
  if (!clientKinds.includes(run?.client?.kind)) fail(`run.client.kind must be one of ${clientKinds.join(", ")}`);
  for (const [field, shape] of Object.entries(clientLabels)) if (typeof run?.client?.[field] !== "string" || !shape.test(run.client[field])) fail(`run.client.${field} must be a lowercase label`);
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
    if (typeof metric?.source !== "string" || !label.test(metric.source)) fail(`${name}: source must be a lowercase label`);
    sampleProblems(name, metric, fail);
  }
}

/**
 * @param {string} name
 * @param {any} metric
 * @param {(problem: string) => void} fail
 */
function sampleProblems(name, metric, fail) {
  if (!Number.isInteger(metric?.n) || metric.n < 0) return fail(`${name}: n must be a whole number`);
  const percentiles = [metric.p50, metric.p95];
  if (metric.n === 0) {
    if (percentiles.some((value) => value !== null)) fail(`${name}: p50 and p95 must be null without samples`);
    return;
  }
  if (!percentiles.every((value) => Number.isFinite(value) && value >= 0)) fail(`${name}: p50 and p95 must be non-negative numbers`);
  else if (metric.p50 > metric.p95) fail(`${name}: p50 is above p95`);
}

/**
 * @param {any} dropped
 * @param {(problem: string) => void} fail
 */
function dropProblems(dropped, fail) {
  if (!Array.isArray(dropped)) return fail("dropped must be an array");
  for (const drop of dropped) {
    exactKeys(drop, ["metric", "reason", "count"], `dropped ${drop?.metric}`, fail);
    if (drop?.metric !== WHOLE_CYCLE && !(drop?.metric in METRICS)) fail(`dropped: unknown metric ${drop?.metric}`);
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
 * countsAsEvidence says whether a card may gate a run or serve as a baseline. A contended or unobservable
 * measurement is diagnostic only, so every reader asks this one question instead of reading the two flags.
 * @param {Scorecard} card
 */
export function countsAsEvidence(card) {
  return !card.contention?.contended && !card.contention?.unobservable;
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

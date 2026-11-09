// The latency kit writes its round trips, stage timings and audio-delay estimate to a sidecar file next to the scorecard, not into the card. The card
// keeps the shape every reader already knows, so the gate, the diff, the history and the baseline never parse these numbers and
// no value here can change a verdict. The run summary is the only reader, and it never throws: a file that is missing or
// invalid becomes one line of text.
import { AUDIO_KEYS, AUDIO_PARTS, RETIRED_STAGE_IDS, RTT_KEYS, STAGE_GROUPS, STAGE_IDS } from "./stages.mjs";

export const DIAGNOSTICS_SCHEMA = "chalk.latency-diagnostics/v1";
export const diagnosticsFileName = (plane) => `latency-diagnostics-${plane}.json`;

const LABELS = { sfu_ms: "SFU", sync_ms: "Sync" };
const MAX_CYCLES = 60;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isMilliseconds = (value) => value === null || (Number.isFinite(value) && value >= 0);

function mapProblem(map, keys, where) {
  if (!isObject(map)) return `${where} must be an object`;
  for (const [key, value] of Object.entries(map)) {
    if (!keys.includes(key)) return `${where} has unknown field ${key}`;
    if (!isMilliseconds(value)) return `${where}.${key} must be non-negative milliseconds or null`;
  }
  return undefined;
}

function statProblem(stat, where) {
  if (!isObject(stat) || !Number.isSafeInteger(stat.n) || stat.n < 0) return `${where} needs a sample count`;
  if (!isMilliseconds(stat.p50) || !isMilliseconds(stat.p95)) return `${where} has an invalid percentile`;
  if (stat.n === 0 ? stat.p50 !== null || stat.p95 !== null : stat.p50 === null || stat.p95 === null || stat.p50 > stat.p95) return `${where} percentiles do not match its sample count`;
  return undefined;
}

function unknownField(value, allowed, where) {
  const key = Object.keys(value).find((name) => !allowed.includes(name));
  return key === undefined ? undefined : `${where} has unknown field ${key}`;
}

const ACCEPTED_STAGE_IDS = [...STAGE_IDS, ...RETIRED_STAGE_IDS];

function summaryProblem(summary) {
  if (!isObject(summary)) return "summary must be an object";
  const unknown = unknownField(summary, ["rtt", "stages", "audio"], "summary");
  if (unknown) return unknown;
  for (const [group, keys] of [
    ["rtt", RTT_KEYS],
    ["stages", ACCEPTED_STAGE_IDS],
    ["audio", AUDIO_KEYS],
  ]) {
    const stats = summary[group];
    if (stats === undefined) continue;
    if (!isObject(stats)) return `summary.${group} must be an object`;
    for (const [key, stat] of Object.entries(stats)) {
      if (!keys.includes(key)) return `summary.${group} has unknown field ${key}`;
      const problem = statProblem(stat, `summary.${group}.${key}`);
      if (problem) return problem;
    }
  }
  return undefined;
}

/**
 * problemOf names the first thing wrong with a parsed sidecar, or returns undefined when it is valid.
 * @param {unknown} file
 */
export function problemOf(file) {
  if (!isObject(file) || file.schema !== DIAGNOSTICS_SCHEMA) return `schema must be ${DIAGNOSTICS_SCHEMA}`;
  const unknown = unknownField(file, ["schema", "plane", "cycles", "summary"], "file");
  if (unknown) return unknown;
  if (!Array.isArray(file.cycles) || file.cycles.length > MAX_CYCLES) return `cycles must be a list of at most ${MAX_CYCLES}`;
  for (const [index, cycle] of file.cycles.entries()) {
    if (!isObject(cycle)) return `cycles[${index}] must be an object`;
    const extra = unknownField(cycle, ["cycle", "timestamp", "rtt", "stages", "audio"], `cycles[${index}]`);
    if (extra) return extra;
    const problem =
      (cycle.rtt === undefined ? undefined : mapProblem(cycle.rtt, RTT_KEYS, `cycles[${index}].rtt`)) ??
      (cycle.stages === undefined ? undefined : mapProblem(cycle.stages, ACCEPTED_STAGE_IDS, `cycles[${index}].stages`)) ??
      (cycle.audio === undefined ? undefined : mapProblem(cycle.audio, AUDIO_KEYS, `cycles[${index}].audio`));
    if (problem) return problem;
  }
  return summaryProblem(file.summary);
}

/**
 * diagnosticsMarkdown renders the summary of a valid sidecar.
 * @param {{ rtt?: Record<string, {n: number, p50: number | null, p95: number | null}>, stages?: Record<string, {n: number, p50: number | null, p95: number | null}>, audio?: Record<string, {n: number, p50: number | null, p95: number | null}> }} summary
 */
export function diagnosticsMarkdown(summary) {
  const stat = (value) => (value && value.n > 0 ? `${value.p50} / ${value.p95} ms (n=${value.n})` : "no samples");
  const lines = ["#### Action latency diagnostics", "", "Informational: no budget, gate or verdict reads these. Times are p50 / p95 per cycle.", ""];
  const rtt = RTT_KEYS.filter((key) => summary.rtt?.[key]).map((key) => `${LABELS[key]} ${stat(summary.rtt?.[key])}`);
  if (rtt.length) lines.push(`Round trip from the runner: ${rtt.join("; ")}.`, "");
  const audio = AUDIO_PARTS.filter((part) => summary.audio?.[part.id]);
  if (audio.length) {
    lines.push("**Audio delay a listener adds** (estimated from the listener's WebRTC stats while the call was steady; not mouth to ear)", "", "| Part | n | p50 | p95 | What it covers |", "|---|---|---|---|---|");
    for (const part of audio) {
      const value = summary.audio?.[part.id];
      lines.push(`| \`${part.id}\` | ${value?.n} | ${value?.p50 ?? "–"} | ${value?.p95 ?? "–"} | ${part.description} |`);
    }
    lines.push("");
  }
  for (const group of STAGE_GROUPS) {
    const rows = group.stages.filter((stage) => summary.stages?.[`${group.id}.${stage.id}`]);
    if (!rows.length) continue;
    lines.push(`**${group.title}** (${group.metrics})`, "", "| Stage | Since | n | p50 | p95 | What it covers |", "|---|---|---|---|---|---|");
    for (const stage of rows) {
      const value = summary.stages?.[`${group.id}.${stage.id}`];
      lines.push(`| \`${stage.id}\` | ${stage.from === "call" ? "call" : "previous stage"} | ${value?.n} | ${value?.p50 ?? "–"} | ${value?.p95 ?? "–"} | ${stage.description} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * diagnosticsReport turns the sidecar's text into run-summary markdown. It never throws; text that is absent, not JSON or invalid
 * becomes a one-line note, because the diagnostics explain the gated numbers and are never a reason to stop.
 * @param {string | undefined} text  The file's content, or undefined when there is no file.
 */
export function diagnosticsReport(text) {
  if (text === undefined) return "Action latency diagnostics: none recorded.\n";
  try {
    const file = JSON.parse(text);
    const problem = problemOf(file);
    return problem ? `Action latency diagnostics: invalid, not shown (${problem}).\n` : diagnosticsMarkdown(file.summary);
  } catch {
    return "Action latency diagnostics: invalid, not shown (not JSON).\n";
  }
}

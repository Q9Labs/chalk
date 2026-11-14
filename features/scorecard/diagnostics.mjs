// The latency kit writes its round trips, stage timings and audio-delay estimate to a sidecar file next to the scorecard, not into the card. The card
// keeps the shape every reader already knows, so the gate, the diff, the history and the baseline never parse these numbers and
// no value here can change a verdict. The run summary is the only reader, and it never throws: a file that is missing or
// invalid becomes one line of text.
import { AUDIO_KEYS, AUDIO_PARTS, RTT_KEYS, STAGE_GROUPS, STAGE_IDS } from "./stages.mjs";

export const DIAGNOSTICS_SCHEMA = "chalk.latency-diagnostics/v1";
export const diagnosticsFileName = (plane) => `latency-diagnostics-${plane}.json`;

/** The candidate types a selected ICE pair reports (RTCIceCandidateStats.candidateType). */
export const ICE_CANDIDATE_TYPES = ["host", "srflx", "prflx", "relay"];
/** The relay protocols a relay candidate reports (RTCIceCandidateStats.relayProtocol). */
export const ICE_RELAY_PROTOCOLS = ["udp", "tcp", "tls"];
/** The network paths the latency kit can force; "direct" is the browser's own choice. */
export const ICE_PATHS = ["direct", "relay-udp", "relay-tcp", "relay-tls", "blocked-no-relay", "blocked-relay-tls"];
/** What a guest received over the call, per cycle; the summary holds p50 and p95 of each. */
export const PATH_RECEIVE_KEYS = ["audio_loss_pct", "video_loss_pct", "audio_jitter_ms", "video_jitter_ms"];
const PAIR_KEYS = ["unknown", ...ICE_CANDIDATE_TYPES.flatMap((local) => ICE_CANDIDATE_TYPES.map((remote) => `${local}/${remote}`))];
const ICE_TYPE_FIELDS = ["local_type", "remote_type"];
const ICE_RELAY_FIELD = "relay_protocol";
const ICE_TRANSPORT_FIELD = "protocol";
const ICE_COUNT_FIELDS = ["requests_sent", "responses_received"];
const ICE_TIME_FIELD = "read_after_ms";

const LABELS = { sfu_ms: "SFU", sync_ms: "Sync" };
const SINCE = { call: "call", previous: "previous stage", span: "(time inside the step)" };
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

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function iceProblem(ice, where) {
  if (!isObject(ice)) return `${where} must be an object`;
  const unknown = unknownField(ice, [...ICE_TYPE_FIELDS, ICE_TRANSPORT_FIELD, ICE_RELAY_FIELD, ...ICE_COUNT_FIELDS, ICE_TIME_FIELD], where);
  if (unknown) return unknown;
  for (const field of ICE_TYPE_FIELDS) if (ice[field] !== undefined && ice[field] !== null && !ICE_CANDIDATE_TYPES.includes(ice[field])) return `${where}.${field} must be a candidate type or null`;
  if (ice[ICE_TRANSPORT_FIELD] !== undefined && ice[ICE_TRANSPORT_FIELD] !== null && !["udp", "tcp"].includes(ice[ICE_TRANSPORT_FIELD])) return `${where}.${ICE_TRANSPORT_FIELD} must be udp, tcp or null`;
  if (ice[ICE_RELAY_FIELD] !== undefined && ice[ICE_RELAY_FIELD] !== null && !ICE_RELAY_PROTOCOLS.includes(ice[ICE_RELAY_FIELD])) return `${where}.${ICE_RELAY_FIELD} must be a relay protocol or null`;
  for (const field of ICE_COUNT_FIELDS) if (ice[field] !== undefined && ice[field] !== null && !isCount(ice[field])) return `${where}.${field} must be a count or null`;
  if (ice[ICE_TIME_FIELD] !== undefined && !isMilliseconds(ice[ICE_TIME_FIELD])) return `${where}.${ICE_TIME_FIELD} must be non-negative milliseconds or null`;
  return undefined;
}

function iceSummaryProblem(ice) {
  if (!isObject(ice)) return "summary.ice must be an object";
  const unknown = unknownField(ice, ["pairs", "relay_protocols", "unanswered_checks"], "summary.ice");
  if (unknown) return unknown;
  if (ice.pairs !== undefined) {
    if (!isObject(ice.pairs)) return "summary.ice.pairs must be an object";
    for (const [key, count] of Object.entries(ice.pairs)) {
      if (!PAIR_KEYS.includes(key)) return `summary.ice.pairs has unknown field ${key}`;
      if (!isCount(count)) return `summary.ice.pairs.${key} must be a count`;
    }
  }
  if (ice.relay_protocols !== undefined) {
    if (!isObject(ice.relay_protocols)) return "summary.ice.relay_protocols must be an object";
    for (const [key, count] of Object.entries(ice.relay_protocols)) {
      if (!ICE_RELAY_PROTOCOLS.includes(key)) return `summary.ice.relay_protocols has unknown field ${key}`;
      if (!isCount(count)) return `summary.ice.relay_protocols.${key} must be a count`;
    }
  }
  return ice.unanswered_checks === undefined ? undefined : statProblem(ice.unanswered_checks, "summary.ice.unanswered_checks");
}

const isPercentOrMs = (value) => value === null || (Number.isFinite(value) && value >= 0);

function pathProblem(path, where) {
  if (!isObject(path)) return `${where} must be an object`;
  const unknown = unknownField(path, ["mode", "joined", ...PATH_RECEIVE_KEYS], where);
  if (unknown) return unknown;
  if (!ICE_PATHS.includes(path.mode)) return `${where}.mode must be a known path`;
  if (typeof path.joined !== "boolean") return `${where}.joined must be true or false`;
  for (const key of PATH_RECEIVE_KEYS) if (path[key] !== undefined && !isPercentOrMs(path[key])) return `${where}.${key} must be a non-negative number or null`;
  return undefined;
}

function pathSummaryProblem(path) {
  if (!isObject(path)) return "summary.path must be an object";
  const unknown = unknownField(path, ["mode", "cycles", "joined", "receive"], "summary.path");
  if (unknown) return unknown;
  if (!ICE_PATHS.includes(path.mode)) return "summary.path.mode must be a known path";
  if (!isCount(path.cycles) || !isCount(path.joined) || path.joined > path.cycles) return "summary.path needs cycle and join counts";
  if (path.receive === undefined) return undefined;
  if (!isObject(path.receive)) return "summary.path.receive must be an object";
  for (const [key, stat] of Object.entries(path.receive)) {
    if (!PATH_RECEIVE_KEYS.includes(key)) return `summary.path.receive has unknown field ${key}`;
    const problem = statProblem(stat, `summary.path.receive.${key}`);
    if (problem) return problem;
  }
  return undefined;
}

function summaryProblem(summary) {
  if (!isObject(summary)) return "summary must be an object";
  const unknown = unknownField(summary, ["rtt", "stages", "audio", "ice", "path"], "summary");
  if (unknown) return unknown;
  if (summary.ice !== undefined) {
    const problem = iceSummaryProblem(summary.ice);
    if (problem) return problem;
  }
  if (summary.path !== undefined) {
    const problem = pathSummaryProblem(summary.path);
    if (problem) return problem;
  }
  for (const [group, keys] of [
    ["rtt", RTT_KEYS],
    ["stages", STAGE_IDS],
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
    const extra = unknownField(cycle, ["cycle", "timestamp", "rtt", "stages", "audio", "ice", "path"], `cycles[${index}]`);
    if (extra) return extra;
    const problem =
      (cycle.rtt === undefined ? undefined : mapProblem(cycle.rtt, RTT_KEYS, `cycles[${index}].rtt`)) ??
      (cycle.stages === undefined ? undefined : mapProblem(cycle.stages, STAGE_IDS, `cycles[${index}].stages`)) ??
      (cycle.audio === undefined ? undefined : mapProblem(cycle.audio, AUDIO_KEYS, `cycles[${index}].audio`)) ??
      (cycle.ice === undefined ? undefined : iceProblem(cycle.ice, `cycles[${index}].ice`)) ??
      (cycle.path === undefined ? undefined : pathProblem(cycle.path, `cycles[${index}].path`));
    if (problem) return problem;
  }
  return summaryProblem(file.summary);
}

/**
 * diagnosticsMarkdown renders the summary of a valid sidecar.
 * @param {{ rtt?: Record<string, {n: number, p50: number | null, p95: number | null}>, stages?: Record<string, {n: number, p50: number | null, p95: number | null}>, audio?: Record<string, {n: number, p50: number | null, p95: number | null}>, ice?: { pairs?: Record<string, number>, unanswered_checks?: {n: number, p50: number | null, p95: number | null} } }} summary
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
  if (summary.ice) {
    const pairs = Object.entries(summary.ice.pairs ?? {}).map(([pair, count]) => `${pair} ${count}`);
    const checks = summary.ice.unanswered_checks;
    const relays = Object.entries(summary.ice.relay_protocols ?? {}).map(([protocol, count]) => `${protocol} ${count}`);
    lines.push(
      "**ICE pair when the join connected** (local/remote candidate type of the selected pair; a relay pair means TURN carries the media)",
      "",
      `Selected pairs: ${pairs.length ? pairs.join(", ") : "none"}.${relays.length ? ` Relay protocol: ${relays.join(", ")}.` : ""}`,
      `Checks sent without a reply on that pair: ${checks && checks.n > 0 ? `${checks.p50} / ${checks.p95} (n=${checks.n})` : "no samples"}. Well above zero means the first ICE checks were lost.`,
      "",
    );
  }
  if (summary.path) {
    const receive = PATH_RECEIVE_KEYS.filter((key) => summary.path.receive?.[key]).map((key) => `${key} ${summary.path.receive[key].p50} / ${summary.path.receive[key].p95} (n=${summary.path.receive[key].n})`);
    lines.push(`**Network path \`${summary.path.mode}\`**: ${summary.path.joined} of ${summary.path.cycles} cycles joined.${receive.length ? ` Received over the call, p50 / p95: ${receive.join("; ")}.` : ""}`, "");
  }
  for (const group of STAGE_GROUPS) {
    const rows = group.stages.filter((stage) => summary.stages?.[`${group.id}.${stage.id}`]);
    if (!rows.length) continue;
    lines.push(`**${group.title}** (${group.metrics})`, "", "| Stage | Since | n | p50 | p95 | What it covers |", "|---|---|---|---|---|---|");
    for (const stage of rows) {
      const value = summary.stages?.[`${group.id}.${stage.id}`];
      lines.push(`| \`${stage.id}\` | ${SINCE[stage.from]} | ${value?.n} | ${value?.p50 ?? "–"} | ${value?.p95 ?? "–"} | ${stage.description} |`);
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

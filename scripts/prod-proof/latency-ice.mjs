// The selected ICE pair at the moment the joining guest's first peer connection connected, for the diagnostics sidecar.
// latency-trace.mjs records an "ice_pair" event beside each "ice_connected"; these pure functions pick the one the join timed
// and summarize it over the kept cycles. Nothing here reads or changes the card: a reading that is missing or malformed is null.
import { ICE_CANDIDATE_TYPES } from "../../features/scorecard/diagnostics.mjs";
import { summarize } from "./latency-stats.mjs";

/** @typedef {{ local_type: string | null, remote_type: string | null, requests_sent: number | null, responses_received: number | null }} IceReading */

const candidateType = (value) => (ICE_CANDIDATE_TYPES.includes(value) ? value : null);
const counter = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/** The pair key counted in the summary: both candidate types, or "unknown" when either is missing. */
const pairKey = (ice) => (ice.local_type && ice.remote_type ? `${ice.local_type}/${ice.remote_type}` : "unknown");

/**
 * icePairOf reads the selected pair of the first peer connection that connected at or after t0 (the one join.ice_connected times).
 * @param {{ t: number, k: string, d?: string }[]} events  The joining guest's page trace.
 * @param {number} t0
 * @returns {IceReading | null}
 *   null when that connection never connected or its pair could not be read.
 */
export function icePairOf(events, t0) {
  const connected = events.find((event) => event.t >= t0 && event.k === "ice_connected");
  if (!connected) return null;
  for (const event of events) {
    if (event.k !== "ice_pair" || typeof event.d !== "string") continue;
    let reading;
    try {
      reading = JSON.parse(event.d);
    } catch {
      continue;
    }
    if (reading?.since !== connected.t) continue;
    return { local_type: candidateType(reading.local), remote_type: candidateType(reading.remote), requests_sent: counter(reading.requestsSent), responses_received: counter(reading.responsesReceived) };
  }
  return null;
}

/**
 * iceSummary counts the cycles by pair type and gives n, p50 and p95 of the checks the winning pair sent that never got a reply
 * (requestsSent - responsesReceived). A pair that reports more replies than requests has no such count and is left out of it.
 * @param {(IceReading | undefined)[]} readings
 * @returns {{ pairs: Record<string, number>, unanswered_checks: { n: number, p50: number | null, p95: number | null } } | undefined}
 *   undefined when no cycle has a reading.
 */
export function iceSummary(readings) {
  const found = readings.filter((ice) => ice !== undefined);
  if (!found.length) return undefined;
  const pairs = {};
  for (const ice of found) pairs[pairKey(ice)] = (pairs[pairKey(ice)] ?? 0) + 1;
  const unanswered = found.map((ice) => (ice.requests_sent === null || ice.responses_received === null ? null : ice.requests_sent - ice.responses_received)).filter((value) => value !== null && value >= 0);
  const { n, p50, p95 } = summarize(unanswered.map((value) => ({ unanswered: value }))).unanswered ?? { n: 0, p50: null, p95: null };
  return { pairs, unanswered_checks: { n, p50, p95 } };
}

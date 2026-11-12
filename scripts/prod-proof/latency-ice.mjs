// The selected ICE pair of the joining guest's first peer connection, for the diagnostics sidecar. latency-trace.mjs marks each
// "ice_connected" with a unique connection token and reads the pair afterwards ("ice_pair", same token); these pure functions pick the one the join timed
// and summarize it over the kept cycles. Nothing here reads or changes the card: a reading that is missing or malformed is null.
import { ICE_CANDIDATE_TYPES, ICE_RELAY_PROTOCOLS } from "../../features/scorecard/diagnostics.mjs";
import { summarize } from "./latency-stats.mjs";

/** @typedef {{ local_type: string | null, remote_type: string | null, protocol: string | null, relay_protocol: string | null, requests_sent: number | null, responses_received: number | null, read_after_ms: number | null }} IceReading */

const candidateType = (value) => (ICE_CANDIDATE_TYPES.includes(value) ? value : null);
const transport = (value) => (value === "udp" || value === "tcp" ? value : null);
const relayProtocol = (value) => (ICE_RELAY_PROTOCOLS.includes(value) ? value : null);
const milliseconds = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
const counter = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/** The pair key counted in the summary: both candidate types, or "unknown" when either is missing. */
const pairKey = (ice) => (ice.local_type && ice.remote_type ? `${ice.local_type}/${ice.remote_type}` : "unknown");

/**
 * icePairOf reads the selected pair of the first peer connection that connected at or after t0 (the one join.ice_connected times).
 * @param {{ t: number, k: string, d?: string, peer?: number }[]} events  The joining guest's page trace.
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
    if (typeof connected.peer !== "number" || reading?.peer !== connected.peer) continue;
    return {
      local_type: candidateType(reading.local),
      remote_type: candidateType(reading.remote),
      protocol: transport(reading.protocol),
      relay_protocol: relayProtocol(reading.relayProtocol),
      requests_sent: counter(reading.requestsSent),
      responses_received: counter(reading.responsesReceived),
      read_after_ms: milliseconds(reading.readAfterMs),
    };
  }
  return null;
}

/**
 * iceSummary counts the cycles by pair type and gives n, p50 and p95 of the checks the winning pair sent that never got a reply
 * (requestsSent - responsesReceived). A pair that reports more replies than requests has no such count and is left out of it.
 * @param {(IceReading | undefined)[]} readings
 * @returns {{ pairs: Record<string, number>, relay_protocols?: Record<string, number>, unanswered_checks: { n: number, p50: number | null, p95: number | null } } | undefined}
 *   undefined when no cycle has a reading.
 */
export function iceSummary(readings) {
  const found = readings.filter((ice) => ice !== undefined);
  if (!found.length) return undefined;
  const pairs = {};
  for (const ice of found) pairs[pairKey(ice)] = (pairs[pairKey(ice)] ?? 0) + 1;
  const unanswered = found.map((ice) => (ice.requests_sent === null || ice.responses_received === null ? null : ice.requests_sent - ice.responses_received)).filter((value) => value !== null && value >= 0);
  const { n, p50, p95 } = summarize(unanswered.map((value) => ({ unanswered: value }))).unanswered ?? { n: 0, p50: null, p95: null };
  const relayProtocols = {};
  for (const ice of found) if (ice.relay_protocol) relayProtocols[ice.relay_protocol] = (relayProtocols[ice.relay_protocol] ?? 0) + 1;
  return { pairs, ...(Object.keys(relayProtocols).length ? { relay_protocols: relayProtocols } : {}), unanswered_checks: { n, p50, p95 } };
}

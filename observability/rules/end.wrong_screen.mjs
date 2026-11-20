// end.wrong_screen: the Episode ended for an authoritative reason, but a client in it chose a failure end screen.
//
// Evidence comes in by witness id (see areas/end.json): server_end rows are sync.episode.ended and client_end rows
// are client.call_ended. A client row counts when it is in the same Episode, chose connection_lost or join_failed,
// and its est_server_ms falls in a window around the server end, widened by the row's clock_err_ms. A client row
// with no est_server_ms (an unsynced clock) can't be placed in time, so it never makes a hit. No hit is not a
// healthy verdict, only the absence of proof.

export const symptom = "end.wrong_screen";

const FAILURE_SCREENS = new Set(["connection_lost", "join_failed"]);
// Media is revoked as part of ending, so a client can fail a little before the end commits.
const BEFORE_MS = 10_000;
// A client that loses the end notice keeps going until its own recovery gives up.
const AFTER_MS = 120_000;

/**
 * @typedef {{ readonly [field: string]: unknown }} Row
 * @typedef {{ readonly symptom: string, readonly episode_id: string, readonly client_session_id: string, readonly server_end_reason: string, readonly client_end_reason: string, readonly offset_ms: number, readonly evidence: readonly unknown[] }} RuleHit
 * @param {{ readonly [witness: string]: readonly Row[] }} evidence
 * @returns {RuleHit[]}
 */
export function evaluate(evidence) {
  const hits = [];
  for (const end of evidence.server_end ?? []) {
    if (typeof end.est_server_ms !== "number") continue;
    for (const client of evidence.client_end ?? []) {
      if (client.episode_id !== end.episode_id || !FAILURE_SCREENS.has(String(client.end_reason))) continue;
      if (typeof client.est_server_ms !== "number") continue;
      const error = typeof client.clock_err_ms === "number" ? client.clock_err_ms : 0;
      const offset = client.est_server_ms - end.est_server_ms;
      if (offset < -BEFORE_MS - error || offset > AFTER_MS + error) continue;
      hits.push({
        symptom,
        episode_id: String(end.episode_id),
        client_session_id: String(client.client_session_id),
        server_end_reason: String(end.end_reason),
        client_end_reason: String(client.end_reason),
        offset_ms: offset,
        evidence: [end.event_id, client.event_id].filter((id) => id !== undefined),
      });
    }
  }
  return hits;
}

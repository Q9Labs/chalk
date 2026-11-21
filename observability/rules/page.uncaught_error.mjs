// @ts-check
/**
 * page.uncaught_error: an uncaught error or rejection hit the call page during a live call, and the page kept running.
 *
 * render_cause unhandled_error and unhandled_rejection count; chunk_load-classified ones belong to page.crashed, not here.
 * Two reports with the same fingerprint count as one crash recurring.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "page.uncaught_error";
export const settle_ms = 120_000;
export const expected = "no uncaught error or unhandled rejection reaches the call page during a live call";

/** @param {DecideInput["declaration"]} declaration @param {DecideInput["seat"]} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const heartbeat = readings["perf.heartbeat"];
  const crashes = readings["page.render_crash"];
  if (heartbeat.kind !== "present") return { status: "unknown", reason: "the seat's client evidence is not witnessed" };
  if (crashes.kind !== "present") return { status: "pass" };
  const uncaught = crashes.observations.filter((o) => (o.claim === "unhandled_error" || o.claim === "unhandled_rejection") && o.value.error_class !== "chunk_load");
  if (uncaught.length === 0) return { status: "pass" };
  const fingerprints = new Set(uncaught.map((o) => o.value.error_fingerprint ?? o.id));
  const first = uncaught[0];
  const last = uncaught.at(-1);
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: first.window.from_ms, to_ms: last.window.to_ms },
    hop: "client_render",
    module: "web.space_call",
    reason: null,
    upstream: "witnessed",
    observed: `the call page hit ${uncaught.length} uncaught ${uncaught.length === 1 ? "failure" : "failures"} (${first.claim}${uncaught.length > 1 ? `, ${fingerprints.size} distinct` : ""})`,
    facts: [{ text: `uncaught failures: ${uncaught.map((o) => o.claim).join(", ")}`, evidence: uncaught.map((o) => o.id), window: { from_ms: first.window.from_ms, to_ms: last.window.to_ms }, absent: null }],
    hypothesis: { text: "an unhandled error or rejection reached the page root", falsified_by: "a complete call with no uncaught failure rows" },
    falsify: { absence: null, attribution: "a complete call with no unhandled error or rejection" },
  };
}

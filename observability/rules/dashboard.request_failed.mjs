// @ts-check
/**
 * dashboard.request_failed: a /dashboard-api/* request failed with 5xx, or valid sign-ins were rejected as unreadable. The
 * function log reaches the checker through the edge feed; the api http.request of the upstream call is independent. 401s are
 * expected when the session was expired or missing, broken only when unreadable for 3+ distinct visitors in 15 min.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

export const symptom = "dashboard.request_failed";

const unreadable_min_visitors = 3;
const unreadable_window_ms = 900_000;

export const expected = "dashboard requests fail only upstream of the function, and sign-ins are never rejected as unreadable";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "platform";

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings }) {
  const fn = readings["dashboard.function"];
  const upstream = readings["dashboard.upstream"];
  if (fn.kind === "unknown") return { status: "unknown", reason: "edge unavailable" };
  if (upstream.kind === "unknown") return { status: "unknown", reason: "api incomplete" };
  if (fn.kind !== "present") return { status: "pass" };
  const rows = fn.observations;

  const serverError = rows.find((o) => o.claim >= 500);
  if (serverError) {
    const hop = /** @type {number} */ (serverError.value.upstream_status ?? 0) >= 500 ? "dashboard_upstream" : "dashboard_function";
    return {
      status: "finding",
      outcome: "broken",
      window: serverError.window,
      hop,
      module: "web.dashboard_server",
      reason: null,
      upstream: "witnessed",
      observed: `a /dashboard-api/${serverError.value.page ?? "?"} ${serverError.value.method ?? "GET"} returned ${serverError.claim}`,
      facts: [
        { text: `dashboard.request_failed status=${serverError.claim}${serverError.value.upstream_status ? ` upstream_status=${serverError.value.upstream_status}` : ""}`, evidence: [serverError.id], window: serverError.window, absent: null },
      ],
      hypothesis: { text: hop === "dashboard_upstream" ? "the upstream api call failed" : "the Pages function itself failed", falsified_by: "a 2xx for the same request" },
      falsify: { absence: "the failure row", attribution: "a different page or status" },
    };
  }

  const unreadable = rows.filter((o) => o.claim === 401 && o.value.auth_result === "unreadable").sort((a, b) => a.window.from_ms - b.window.from_ms);
  for (let i = 0; i < unreadable.length; i += 1) {
    const group = [unreadable[i]];
    const seen = new Set([unreadable[i].value.client_session_id]);
    for (let j = i + 1; j < unreadable.length && unreadable[j].window.from_ms - unreadable[i].window.from_ms <= unreadable_window_ms; j += 1) {
      if (!seen.has(unreadable[j].value.client_session_id)) {
        seen.add(unreadable[j].value.client_session_id);
        group.push(unreadable[j]);
      }
    }
    if (seen.size >= unreadable_min_visitors) {
      const window = { from_ms: group[0].window.from_ms, to_ms: group[group.length - 1].window.from_ms };
      return {
        status: "finding",
        outcome: "broken",
        window,
        hop: "dashboard_auth",
        module: "web.dashboard_server",
        reason: null,
        upstream: "witnessed",
        observed: `${seen.size} valid sign-ins were rejected as unreadable within 15 min`,
        facts: [{ text: `401 auth_result=unreadable for ${seen.size} distinct cs_ within 15 min`, evidence: group.map((o) => o.id), window, absent: null }],
        hypothesis: { text: "the session secret or cookie format changed under running sessions", falsified_by: "fewer than 3 unreadable visitors" },
        falsify: { absence: "the unreadable rows", attribution: "expired or missing sessions" },
      };
    }
    i += group.length - 1;
  }

  const signedOut = rows.find((o) => o.claim === 401 && (o.value.auth_result === "expired" || o.value.auth_result === "missing"));
  if (signedOut) {
    return {
      status: "finding",
      outcome: "expected",
      window: signedOut.window,
      hop: null,
      module: null,
      reason: "dashboard.signed_out",
      upstream: "witnessed",
      observed: `a 401 with auth_result=${signedOut.value.auth_result}`,
      facts: [{ text: `401 auth_result=${signedOut.value.auth_result}`, evidence: [signedOut.id], window: signedOut.window, absent: null }],
      hypothesis: null,
      falsify: { absence: null, attribution: "an unreadable session" },
    };
  }
  return { status: "pass" };
}

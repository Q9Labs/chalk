// @ts-check
/**
 * integration.credential_refused: an API key was refused and never authenticated successfully inside the window. Recovery is an
 * `accepted` authenticate decision for the same key after the last refusal, or — when request logs are complete — any 2xx request
 * carrying the key. A key refused once then accepted passes; a revoked, expired or bad key that keeps being presented is broken.
 *
 * The witnesses are in areas/webhooks.json: `integration.auth` authenticate decisions from the API, `integration.request`
 * request rows from the API log, `integration.api_key` from Postgres and the `integration.request_log_mode` flag snapshot, which
 * bounds how far request rows can prove a recovery.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "integration.credential_refused";

export const expected = "every refused API key either authenticates later in the window or its refusal is a finding";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "tenant";

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const auth = readings["integration.auth"];
  const requests = readings["integration.request"];
  const keys = readings["integration.api_key"];
  const mode = readings["integration.request_log_mode"];
  if (auth.kind === "unknown") return { status: "unknown", reason: "the authenticate decisions are not fully read" };
  if (auth.kind === "absent") return { status: "pass" };
  if (requests.kind === "unknown") return { status: "unknown", reason: "the request log is not fully read" };
  if (keys.kind === "unknown" || mode.kind === "unknown") return { status: "unknown", reason: "the key state or the request-log mode is not fully read" };
  const requestRows = requests.kind === "present" ? requests.observations : [];
  const requestLogComplete = mode.kind === "present" && mode.observations.every((snapshot) => snapshot.value.request_logs === "all");

  /** @type {Map<string, import("../../scripts/diagnose-call/proof/evidence.mjs").Observation[]>} */
  const refused = new Map();
  const accepted = new Map();
  for (const decision of auth.observations) {
    // A refused authentication may never reach a key row: unknown prefixes name only the prefix the request carried.
    const key = typeof decision.value.api_key_id === "string" && decision.value.api_key_id !== "" ? decision.value.api_key_id : decision.value.key_prefix;
    if (typeof key !== "string" || key === "") continue;
    const at = decision.window.from_ms;
    if (decision.value.decision === "rejected") {
      refused.set(key, [...(refused.get(key) ?? []), decision]);
    } else if (decision.value.decision === "accepted") {
      accepted.set(key, [...(accepted.get(key) ?? []), { decision, at }]);
    }
  }
  /** @param {string} key @param {number} after */
  const recovered = (key, after) => {
    if ((accepted.get(key) ?? []).some(({ at }) => at > after)) return true;
    return requestLogComplete && requestRows.some((row) => row.value.api_key_id === key && typeof row.value.status === "number" && row.value.status < 400 && row.window.from_ms > after);
  };
  /** @type {{ key: string, refusals: import("../../scripts/diagnose-call/proof/evidence.mjs").Observation[] }[]} */
  const broken = [];
  for (const [key, refusals] of refused) {
    const last = Math.max(...refusals.map((refusal) => refusal.window.from_ms));
    if (!recovered(key, last)) broken.push({ key, refusals });
  }
  if (broken.length === 0) return { status: "pass" };
  const first = broken[0];
  const keyRow = keys.kind === "present" ? keys.observations.find((row) => row.value.api_key_id === first.key) : undefined;
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: Math.min(...broken.flatMap(({ refusals }) => refusals.map((refusal) => refusal.window.from_ms))), to_ms: window.to_ms },
    hop: "api_authenticate",
    module: "api.auth",
    reason: null,
    upstream: "witnessed",
    observed: `${broken.length} API key(s) refused and never recovered${first ? `; ${first.key} refused ${first.refusals.length} time(s) (${first.refusals[first.refusals.length - 1].value.reason_code ?? "unrecorded"})` : ""}`,
    facts: broken.slice(0, 5).map(({ key, refusals }) => ({
      text: `key ${key} was refused ${refusals.length} time(s) — last as ${refusals[refusals.length - 1].value.reason_code ?? "unrecorded"} — with no accepted authenticate after`,
      evidence: [...refusals.map((refusal) => refusal.id), ...(keyRow && key === first.key ? [keyRow.id] : [])],
      window: { from_ms: refusals[0].window.from_ms, to_ms: refusals[refusals.length - 1].window.to_ms },
      absent: null,
    })),
    hypothesis: { text: "the tenant keeps presenting a revoked, expired or wrong key", falsified_by: "an accepted authenticate for the key after its last refusal" },
    falsify: { absence: "an accepted authenticate decision or a 2xx request for the key after its last refusal", attribution: null },
  };
}

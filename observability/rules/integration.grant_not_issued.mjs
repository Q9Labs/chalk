// @ts-check
/**
 * integration.grant_not_issued: an initial access grant or an admission was refused — by validation, by the admission capacity
 * decision, or by the write rate limit — and the same Participant did not get a success within the recovery window. Initial
 * grants are the `issueAccessGrant` calls with no current media token; renewals belong to another slice and are ignored. When
 * request logs are not complete, a recovery seen only in requests cannot be proven, so the check stays unknown.
 *
 * The witnesses are in areas/webhooks.json: `integration.grant_rejected` and `integration.rate_limit` from the API,
 * `integration.request` request rows, the `integration.request_log_mode` flag snapshot, `webhook.participant` and
 * `webhook.episode` from Postgres, and the optional `integration.capacity` refusal decision.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "integration.grant_not_issued";

/** A refused admission or grant that is retried into a success within this long recovered. */
const RECOVERY_MS = 120_000;
/** The routes a refusal can come from: admissions create participants, grants issue media access. */
const GRANT_ROUTE = "/access-grant";
const ADMISSION_ROUTE = "/participants";

export const expected = "every refused initial grant or admission is retried into a success within two minutes, or its refusal is a finding";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "tenant";

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const requests = readings["integration.request"];
  const rejected = readings["integration.grant_rejected"];
  const rateLimited = readings["integration.rate_limit"];
  const mode = readings["integration.request_log_mode"];
  const participants = readings["webhook.participant"];
  if (requests.kind === "unknown") return { status: "unknown", reason: "the request log is not fully read" };
  if (rejected.kind === "unknown" || rateLimited.kind === "unknown") return { status: "unknown", reason: "the grant and rate-limit decisions are not fully read" };
  if (mode.kind === "unknown" || participants.kind === "unknown") return { status: "unknown", reason: "the request-log mode or the Participants are not fully read" };
  const requestRows = requests.kind === "present" ? requests.observations : [];
  const requestLogComplete = mode.kind === "present" && mode.observations.every((snapshot) => snapshot.value.request_logs === "all");
  const grantRejections = rejected.kind === "present" ? rejected.observations.filter((row) => row.value.grant_kind === "initial") : [];
  const limitRefusals = rateLimited.kind === "present" ? rateLimited.observations.filter((row) => row.value.decision === "refused") : [];

  const refusals = [
    ...grantRejections.map((row) => ({ at: row.window.from_ms, participant: row.value.participant_id, kind: "grant", evidence: [row.id] })),
    ...limitRefusals.map((row) => ({ at: row.window.from_ms, participant: null, kind: "rate_limit", evidence: [row.id] })),
    ...requestRows
      .filter((row) => typeof row.value.status === "number" && row.value.status >= 400 && typeof row.value.route === "string" && (row.value.route.endsWith(GRANT_ROUTE) || row.value.route.endsWith(ADMISSION_ROUTE)))
      .map((row) => ({ at: row.window.from_ms, participant: row.value.participant_id, kind: "request", evidence: [row.id] })),
  ];
  if (refusals.length === 0) return { status: "pass" };
  const participantRows = participants.kind === "present" ? participants.observations : [];
  /** @param {{ at: number, participant: unknown }} refusal */
  const recovered = (refusal) =>
    requestRows.some((row) => typeof row.value.status === "number" && row.value.status < 400 && typeof row.value.route === "string" && (row.value.route.endsWith(GRANT_ROUTE) || row.value.route.endsWith(ADMISSION_ROUTE)) && (refusal.participant === null || refusal.participant === undefined || row.value.participant_id === refusal.participant) && row.window.from_ms > refusal.at && row.window.from_ms <= refusal.at + RECOVERY_MS) ||
    (typeof refusal.participant === "string" && participantRows.some((row) => row.value.participant_id === refusal.participant && typeof row.value.joined_at_ms === "number" && row.value.joined_at_ms >= refusal.at && row.value.joined_at_ms <= refusal.at + RECOVERY_MS));
  const unrecovered = refusals.filter((refusal) => !recovered(refusal));
  if (unrecovered.length === 0) return { status: "pass" };
  if (!requestLogComplete) return { status: "unknown", reason: "request logs are not complete, so a retry the log missed cannot be ruled out" };
  const first = unrecovered[0];
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: Math.min(...unrecovered.map((refusal) => refusal.at)), to_ms: window.to_ms },
    hop: "api_grant",
    module: "api.grants",
    reason: null,
    upstream: "witnessed",
    observed: `${unrecovered.length} grant/admission refusal(s) with no success within ${RECOVERY_MS / 1000} s${first.participant ? `; first Participant ${first.participant}` : ""}`,
    facts: unrecovered.slice(0, 5).map((refusal) => ({
      text: `a ${refusal.kind} refusal at ${new Date(refusal.at).toISOString()}${refusal.participant ? ` for Participant ${refusal.participant}` : ""} had no success within ${RECOVERY_MS / 1000} s`,
      evidence: refusal.evidence,
      window: { from_ms: refusal.at, to_ms: refusal.at + RECOVERY_MS },
      absent: null,
    })),
    hypothesis: { text: "the refusal — validation, capacity or the write rate limit — was never retried into a grant the Participant could use", falsified_by: "a 2xx grant or admission request, or a joined Participant row, within two minutes" },
    falsify: { absence: "a successful grant or admission for the Participant within two minutes of the refusal", attribution: null },
  };
}

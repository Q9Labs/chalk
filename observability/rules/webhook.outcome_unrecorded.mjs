// @ts-check
/**
 * webhook.outcome_unrecorded: the dispatcher's delivery-attempt op finished and recorded an outcome, but no
 * webhook_delivery_attempts row exists for it — the completion write never landed. An attempt op younger than the settle window
 * may still be completing, so it is skipped. An API restart between the op and the read explains nothing here: the completion
 * runs inside the attempt's transaction, so its absence is a write failure, never a shutdown.
 *
 * The witnesses are in areas/webhooks.json: `webhook.attempt_op` from the API, `webhook.attempt` and `webhook.complete_failed`
 * from Postgres and the API log, and `webhook.marker` for restart coverage.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "webhook.outcome_unrecorded";

/** A completion still inside this window may be committing. */
const SETTLE_MS = 30_000;

export const expected = "every finished delivery attempt op has a committed webhook_delivery_attempts row";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "tenant";

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const ops = readings["webhook.attempt_op"];
  const attempts = readings["webhook.attempt"];
  const failures = readings["webhook.complete_failed"];
  if (ops.kind === "unknown") return { status: "unknown", reason: "the API's delivery attempts are not fully read" };
  if (ops.kind === "absent") return { status: "pass" };
  if (attempts.kind === "unknown") return { status: "unknown", reason: "the committed delivery attempts are not fully read" };
  if (failures.kind === "unknown") return { status: "unknown", reason: "the completion failures are not fully read" };
  const rows = attempts.kind === "present" ? attempts.observations : [];
  const completionFailures = failures.kind === "present" ? failures.observations : [];
  const now = window.to_ms;
  const unrecorded = ops.observations.filter((op) => {
    if (typeof op.value.attempt_id !== "string") return false;
    const at = op.window.to_ms ?? op.window.from_ms;
    if (now !== null && now - at < SETTLE_MS) return false;
    return !rows.some((row) => row.value.attempt_id === op.value.attempt_id);
  });
  if (unrecorded.length === 0) return { status: "pass" };
  const first = unrecorded[0];
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: Math.min(...unrecorded.map((op) => op.window.from_ms)), to_ms: now },
    hop: "postgres_complete",
    module: "postgres.complete",
    reason: null,
    upstream: "witnessed",
    observed: `${unrecorded.length} delivery attempt(s) finished with no recorded outcome${first ? `, first ${first.value.attempt_id} on delivery ${first.value.webhook_delivery_id}` : ""}`,
    facts: unrecorded.slice(0, 5).map((op) => ({
      text: `attempt ${op.value.attempt_id} (delivery ${op.value.webhook_delivery_id}) ended ${op.value.outcome ?? "unknown"} but committed no row`,
      evidence: [op.id, ...completionFailures.filter((failure) => failure.value.attempt_id === op.value.attempt_id || failure.value.webhook_delivery_id === op.value.webhook_delivery_id).map((failure) => failure.id)],
      window: op.window,
      absent: "webhook.attempt",
    })),
    hypothesis: { text: "the completion transaction failed after the receiver answered — lease loss or a Postgres write failure", falsified_by: "a webhook_delivery_attempts row for the attempt id" },
    falsify: { absence: "a webhook_delivery_attempts row for each unrecorded attempt id", attribution: null },
  };
}
